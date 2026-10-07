/* ===========================================================================
 * app.js — lógica de Microinventarios (extraída de index.html).
 * Módulo ES: importa Firebase (CDN ESM) y la config de ./firebase-config.js.
 * Se sirve como archivo estático y lo carga <script type="module" src="./app.js">.
 * ======================================================================== */
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getFirestore,collection,doc,setDoc,getDocs,deleteDoc} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {getAuth,signInWithEmailAndPassword,signOut,onAuthStateChanged,setPersistence,browserLocalPersistence,browserSessionPersistence,sendEmailVerification} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* La configuración vive en ./firebase-config.js (no versionada; ver
   firebase-config.example.js y el README). Si el archivo no existe, el build
   de despliegue falla al importarlo: es intencional para no publicar sin config. */
import {firebaseConfig} from "./firebase-config.js";
/* Súper buscador del Historial: módulo puro (sin DOM ni red) que filtra
   registros por proveedor, fecha y datos de artículo. Ver busqueda.js. */
import {buscarRegistros} from "./busqueda.js";

/* Si projectId queda vacío, la página guarda en este navegador (modo local). */
const cloud = !!firebaseConfig.projectId && !!firebaseConfig.apiKey;
let db = null, auth = null, usuario = null;
if (cloud) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  /* La sesión se conserva en este equipo para no perder el acceso al recargar
     la página o reabrir el navegador. Antes se usaba browserSessionPersistence,
     que borra la sesión al cerrar la pestaña: al volver, el historial y los
     reportes aparecían vacíos porque la app no tenía sesión y parecía que no
     había nada guardado. Se usa localStorage y, si el navegador lo bloquea, se
     intenta el modo de sesión y se informa por consola. */
  setPersistence(auth, browserLocalPersistence)
    .catch(()=> setPersistence(auth, browserSessionPersistence).catch(()=>{}));
}
const COL = "auditorias";

/* Envuelve una promesa con un límite de tiempo. Necesario porque, cuando una
   extensión del navegador bloquea Firestore, el SDK reintenta para siempre y la
   espera no termina nunca: el usuario ve la pantalla trabada sin explicación. */
function conLimite(promesa, ms, accion){
  return Promise.race([
    promesa,
    new Promise((_,rechazar)=>setTimeout(
      ()=>rechazar({code:"timeout", message:`La operación de ${accion} excedió ${Math.round(ms/1000)} s. `+
        `Suele deberse a un bloqueador de anuncios o a una red restringida que impide llegar a Firestore.`}),
      ms))
  ]);
}

/* Detecta si el fallo se debe a que el navegador o la red no dejan llegar a
   Firestore. Es el caso de ERR_BLOCKED_BY_CLIENT que provocan los bloqueadores
   de anuncios y las extensiones: el SDK lo reporta como "unavailable" y, si el
   canal ya estaba abierto, a veces como "permission-denied". Distinguirlos es
   imprescindible porque el consejo a seguir es completamente distinto. */
function pareceBloqueo(err){
  const c = (err && err.code) || "";
  const m = ((err && err.message) || "") + " " + ((err && err.name) || "");
  if(c === "unavailable" || c === "deadline-exceeded" || c === "auth/network-request-failed") return true;
  if(/ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|Failed to fetch|NetworkError|blocked|offline/i.test(m)) return true;
  /* Un bloqueo corta el canal de escritura; Firestore lo cierra con TERMINATE. */
  if(/TYPE=terminate|Write\/channel/i.test(m)) return true;
  return false;
}

/* Traduce los errores de Firestore a mensajes claros en español. */
function firebaseError(err){
  const c = (err && err.code) || "";
  /* El bloqueo se comprueba PRIMERO: es la causa más frecuente en este proyecto
     y el mensaje de "permission-denied" desviaba al usuario hacia las reglas y
     la verificación del correo, que no tienen nada que ver. */
  if(pareceBloqueo(err)){
    return "No se pudo conectar con Firestore: el navegador o la red están bloqueando la petición "
         + "(ERR_BLOCKED_BY_CLIENT). Suele ser un bloqueador de anuncios o una extensión. "
         + "Desactiva el bloqueador para este sitio, usa una ventana de incógnito o abre la app en otro equipo; "
         + "tus datos no se perdieron, solo no llegaron al servidor.";
  }
  if(c==="permission-denied"){
    /* Distinguimos la causa: es el error más común y el mensaje genérico confunde. */
    if(usuario && usuario.emailVerified === false){
      return "Firestore rechazó la operación porque tu correo ("+usuario.email+") aún no está verificado. "
           + "Pide a la gerencia que verifique la cuenta en Firebase → Authentication → Users.";
    }
    return "Firestore rechazó la operación (permission-denied). Las reglas no permiten esta acción con tu cuenta; "
         + "revisa que la auditoría te pertenezca y que tu correo esté verificado en Firebase → Authentication → Users.";
  }
  if(c==="unavailable")       return "Sin conexión con Firestore. Revisa tu red; los datos en la nube no se guardaron.";
  if(c==="failed-precondition") return "Firestore necesita un índice o la base de datos aún no está creada en la consola de Firebase.";
  if(c==="invalid-argument")  return "Datos inválidos al guardar en Firestore: "+err.message;
  if(c==="unauthenticated")   return "La sesión expiró. Vuelve a iniciar sesión.";
  if(c==="timeout")           return err.message + " Desactiva el bloqueador de anuncios para este sitio o abre la app en una ventana de incógnito.";
  return "Error de Firebase" + (c ? " ("+c+")" : "") + ": " + ((err && err.message) || String(err));
}

/* Traduce los errores de Firebase Authentication. No revelamos si el correo existe. */
function authError(err){
  const c = (err && err.code) || "";
  if(c==="auth/invalid-credential"||c==="auth/wrong-password"||c==="auth/user-not-found")
    return "Correo o contraseña incorrectos.";
  if(c==="auth/invalid-email")          return "El correo no tiene un formato válido.";
  if(c==="auth/missing-password")       return "Escribe tu contraseña.";
  if(c==="auth/too-many-requests")      return "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.";
  if(c==="auth/user-disabled")          return "Esta cuenta está deshabilitada. Contacta a la gerencia.";
  if(c==="auth/network-request-failed") return "Sin conexión. Revisa tu red e inténtalo de nuevo.";
  if(c==="auth/operation-not-allowed")  return "El acceso con correo y contraseña no está habilitado en la consola de Firebase.";
  if(c==="auth/unauthorized-domain")    return "Este dominio no está autorizado en Firebase Authentication (Authentication → Settings → Dominios autorizados).";
  if(c==="auth/email-already-in-use")   return "Ese correo ya tiene una cuenta.";
  if(c==="auth/weak-password")          return "La contraseña es demasiado débil (mínimo 8 caracteres).";
  if(c==="auth/user-mismatch")          return "La sesión pertenece a otra cuenta. Vuelve a iniciar sesión.";
  if(c==="auth/missing-continue-uri")   return "Falta la URL de continuación al enviar el correo de verificación.";
  if(c==="auth/invalid-continue-uri")   return "La URL de continuación del correo de verificación no es válida.";
  if(c==="auth/unauthorized-continue-uri")
    return "El dominio de esta página no está autorizado para el enlace del correo. Agrégalo en Firebase → Authentication → Settings → Dominios autorizados.";
  return "No se pudo iniciar sesión" + (c ? " ("+c+")" : "") + ": " + ((err && err.message) || String(err));
}

const store = {
  async all(){
    if(!cloud) return JSON.parse(localStorage.getItem(COL)||"[]");
    try{
      const s = await conLimite(getDocs(collection(db,COL)), 15000, "leer"); return s.docs.map(d=>d.data());
    }catch(err){
      badgeError();
      throw new Error(firebaseError(err));
    }
  },
  async save(a){
    if(!cloud){ const l=await this.all(); const i=l.findIndex(x=>x.id===a.id); i<0?l.push(a):l[i]=a; localStorage.setItem(COL,JSON.stringify(l)); return; }
    try{
      /* Si el navegador bloquea la petición (bloqueador de anuncios, ERR_BLOCKED_BY_CLIENT),
         Firebase reintenta sin rendirse y el await nunca regresa. Se pone un límite de
         tiempo para poder avisar al usuario en lugar de dejar la pantalla colgada. */
      await conLimite(setDoc(doc(db,COL,a.id),a), 15000, "guardar");
    }catch(err){
      badgeError();
      /* Las reglas exigen que el documento pertenezca a quien lo escribe
         (esPropietario: resource.data.uid == request.auth.uid). Si el registro
         lo capturó OTRA cuenta, o se guardó antes de tener sesión y quedó sin
         uid, Firestore responde permission-denied y el mensaje genérico de
         "revisa tu correo" despista. Se explica la causa real. */
      if(err && err.code === "permission-denied"){
        /* Solo se consulta el registro previo para saber si es de otra cuenta.
           Si esta consulta falla (p. ej. la red también está bloqueada), NO se
           reemplaza el error original: eso ocultaba la causa real y hacia que un
           simple bloqueo de red se presentara como un problema de reglas. */
        try{
          const previo = (await this.all()).find(x=>x.id===a.id);
          if(previo && previo.uid !== a.uid){
            throw new Error("Esta auditoría la capturó otra cuenta" +
              (previo.email ? " (" + previo.email + ")" : " (sin correo registrado)") +
              ". Solo su autor puede modificarla. Abre una auditoría nueva o pide a gerencia que la borre.");
          }
        }catch(interior){
          if(interior && /la capturó otra cuenta/.test(interior.message||"")) throw interior;
        }
      }
      throw new Error(firebaseError(err));
    }
  },
  async remove(id){
    if(!cloud){ const l=(await this.all()).filter(x=>x.id!==id); localStorage.setItem(COL,JSON.stringify(l)); return; }
    try{
      await conLimite(deleteDoc(doc(db,COL,id)), 15000, "eliminar");
    }catch(err){
      badgeError();
      /* Misma causa que en save(): la regla delete exige ser el dueño del
         registro (o estar en la lista de gerencia). Si lo capturó otra cuenta,
         el permission-denied genérico no explica nada al usuario. */
      if(err && err.code === "permission-denied"){
        try{
          const previo = (await this.all()).find(x=>x.id===id);
          if(previo && usuario && previo.uid !== usuario.uid){
            throw new Error("Esta auditoría la capturó otra cuenta" +
              (previo.email ? " (" + previo.email + ")" : " (sin correo registrado)") +
              ". Solo su autor o gerencia pueden eliminarla.");
          }
        }catch(interior){
          if(interior && /la capturó otra cuenta/.test(interior.message||"")) throw interior;
        }
      }
      throw new Error(firebaseError(err));
    }
  }
};

const badge = document.getElementById("badge");
function badgeError(){ badge.textContent = "Firebase con error"; badge.style.background = "#b3391b"; }

/* ===== Sesión ===== */
const $login = document.getElementById("login"), $app = document.getElementById("app");
const $sesion = document.getElementById("sesion"), $mail = document.getElementById("mail");
const $err = document.getElementById("loginErr"), $btn = document.getElementById("loginBtn");
const $form = document.getElementById("formLogin");

function mostrarLogin(motivo=""){
  usuario = null;
  clearInterval(temporizador);
  /* Al salir se limpia el estado de verificación: si la misma cuenta vuelve a
     entrar sin haber verificado, se le reenviará el correo. */
  enviadoPara = ""; ultimoEnvio = 0;
  document.body.classList.add("sin-sesion");
  $login.classList.add("on");
  $app.hidden = true;
  $app.innerHTML = "";
  $sesion.hidden = true;
  $err.textContent = motivo;
  $form.reset();
  const p = document.getElementById("loginPass"); if(p) p.value = "";
  const m = document.getElementById("loginMail"); if(m) m.focus();
}

/* ===== Verificación de correo ===== */
/* Firebase limita a ~1 correo por minuto por usuario. Guardamos la marca para
   no gastar intentos y para informar al usuario cuánto falta. */
const VERIF_ESPERA = 60;
let ultimoEnvio = 0, temporizador = null, enviadoPara = "";

function esperaRestante(){
  const seg = VERIF_ESPERA - Math.floor((Date.now() - ultimoEnvio) / 1000);
  return seg > 0 ? seg : 0;
}

/* Envía el correo de verificación usando el SDK cliente.
   continueUrl hace que el enlace del correo regrese a esta misma app. */
async function enviarVerificacion(silencioso){
  if(!auth || !auth.currentUser) return false;
  try{
    await sendEmailVerification(auth.currentUser, {
      url: location.origin + location.pathname,
      handleCodeInApp: false
    });
    ultimoEnvio = Date.now();
    return true;
  }catch(err){
    if(err && err.code === "auth/too-many-requests"){
      /* No es un fallo real: Firebase pide esperar. Se trata como enviado. */
      ultimoEnvio = Date.now();
      if(!silencioso) pintarVerificacion("Ya se envió un correo hace poco. Espera un minuto antes de pedir otro.");
      else pintarVerificacion("");
      return true;
    }
    pintarVerificacion(authError(err));
    return false;
  }
}

/* Vuelve a comprobar si el correo ya fue verificado, sin pedir re-login. */
async function revisarVerificacion(){
  if(!auth || !auth.currentUser) return;
  const u = auth.currentUser;
  try{
    await u.reload();
    await u.getIdToken(true);
  }catch(e){}
  if(u.emailVerified === true){
    mostrarApp(u);
  }else{
    pintarVerificacion("Todavía no aparece verificado. Abre el enlace del correo y vuelve a intentar.");
  }
}

/* Cuenta atrás del botón de reenvío, para respetar el límite de Firebase. */
function arrancarTemporizador(){
  clearInterval(temporizador);
  const b = document.getElementById("reenviar");
  if(!b) return;
  const paso = ()=>{
    const s = esperaRestante(), btn = document.getElementById("reenviar");
    if(!btn){ clearInterval(temporizador); return; }
    if(s > 0){ btn.disabled = true; btn.textContent = `Reenviar en ${s} s`; }
    else { btn.disabled = false; btn.textContent = "Reenviar correo"; clearInterval(temporizador); }
  };
  paso();
  temporizador = setInterval(paso, 1000);
}

function pintarVerificacion(aviso){
  const u = auth && auth.currentUser;
  const pendiente = esperaRestante() > 0;
  $app.innerHTML = `<div class="card"><h2>Verifica tu correo para continuar</h2>
    <p class="hint">Enviamos un enlace de verificación a <strong>${esc((u&&u.email)||"")}</strong>.
    Abre el correo y haz clic en el enlace: con eso se habilitan la lectura y el guardado de auditorías.</p>
    <p class="hint">Si no lo ves, revisa la carpeta de <strong>spam</strong> o correo no deseado.</p>
    <div class="bar"><span class="row">
      <button class="btn" id="reenviar" ${pendiente?"disabled":""}>${pendiente?`Reenviar en ${esperaRestante()} s`:"Reenviar correo"}</button>
      <button class="btn sec" id="yaVerifique">Ya verifiqué mi correo</button>
      <button class="btn sec" id="otraCuenta">Usar otra cuenta</button>
    </span></div>
    ${aviso?`<div class="msg">${esc(aviso)}</div>`:""}</div>`;
  arrancarTemporizador();
}

async function mostrarApp(u){
  usuario = u;
  document.body.classList.remove("sin-sesion");
  $login.classList.remove("on");
  $err.textContent = "";
  $app.hidden = false;
  $sesion.hidden = false;
  $mail.textContent = u.email || "";
  /* El servidor exige correo verificado. Si aún no lo está, se envía el correo
     automáticamente y se muestra la pantalla de verificación con reenvío. */
  if(u.emailVerified !== true){
    badge.textContent = "Correo sin verificar";
    badge.style.background = "#b3391b";
    pintarVerificacion("");
    /* Envío automático al entrar, sin esperar clic del usuario.
       Se hace una sola vez por cuenta y sesión (enviadoPara guarda el correo). */
    if(enviadoPara !== u.email){
      enviadoPara = u.email;
      const ok = await enviarVerificacion(false);
      if(ok) pintarVerificacion("Te enviamos el correo de verificación. Revisa tu bandeja de entrada.");
    }
    return;
  }
  badge.textContent = "Firebase conectado";
  badge.style.background = "#2a7a4b";
  A = blank(); vista = "nueva"; msg = "";
  /* Comprobación temprana: si el navegador bloquea Firestore, conviene avisarlo
     YA y no cuando el usuario ya capturó una auditoría entera. Se hace sin
     bloquear la interfaz: si falla, se sigue mostrando la app. */
  try{ await store.all(); }
  catch(err){
    msg = (err && err.message) || String(err);
    badgeError();
  }
  try{ await render(); }
  catch(err){ $app.innerHTML = `<div class="msg">${esc(err.message||err)}</div>`; }
  /* Si quedó un borrador local de un cierre inesperado, se ofrece recuperarlo. */
  recuperarBorrador();
  if(msg) render();
}

$form.addEventListener("submit", async e=>{
  e.preventDefault();
  if(!cloud){ $err.textContent = "Firebase no está configurado; no se puede iniciar sesión."; return; }
  const mail = document.getElementById("loginMail").value.trim();
  const pass = document.getElementById("loginPass").value;
  $err.textContent = ""; $btn.disabled = true; $btn.textContent = "Verificando…";
  try{
    /* La verificación del correo se comprueba en mostrarApp(): si no está
       verificada se muestra una pantalla explicativa en lugar de la app. */
    await signInWithEmailAndPassword(auth, mail, pass);
  }catch(err){
    $err.textContent = authError(err);
    const p = document.getElementById("loginPass"); if(p){ p.value = ""; p.focus(); }
  }finally{
    $btn.disabled = false; $btn.textContent = "Entrar";
  }
});

document.getElementById("salir").addEventListener("click", async ()=>{
  if(!confirm("¿Cerrar la sesión?")) return;
  clearInterval(temporizador);
  try{ await signOut(auth); }catch(err){ alert(authError(err)); }
});

/* Botones de la pantalla de verificación de correo. */
document.addEventListener("click", async e=>{
  const b = e.target.closest("button"); if(!b) return;
  if(b.id === "reenviar"){
    b.disabled = true; b.textContent = "Enviando…";
    const ok = await enviarVerificacion(true);
    if(ok) pintarVerificacion("Correo reenviado. Revisa tu bandeja, incluida la carpeta de spam.");
    return;
  }
  if(b.id === "yaVerifique"){
    b.disabled = true; b.textContent = "Comprobando…";
    await revisarVerificacion();
    return;
  }
  if(b.id === "otraCuenta"){
    clearInterval(temporizador);
    try{ await signOut(auth); }catch(err){ alert(authError(err)); }
  }
});

/* Fuente única de verdad: Firebase avisa cuando entra o sale la sesión. */
if(cloud){
  onAuthStateChanged(auth, async u=>{
    if(!u) return mostrarLogin("");
    /* El token cacheado puede traer emailVerified desactualizado (por ejemplo si
       la cuenta se verificó después de iniciar sesión). Se fuerza una recarga
       para que las reglas y la interfaz vean siempre el estado real. */
    try{ await u.reload(); await u.getIdToken(true); }catch(e){}
    mostrarApp(auth.currentUser || u);
  });
}else{
  /* Sin Firebase no hay control de acceso: la app queda en modo local, abierta. */
  document.body.classList.remove("sin-sesion");
  $login.classList.remove("on");
  $app.hidden = false;
  $sesion.hidden = true;
  badge.textContent = "Modo local (sin Firebase)";
  badge.style.background = "#33414f";
}

/* ===== Utilidades ===== */
const $ = s=>document.querySelector(s);
const num = v=>(v===""||v==null)?null:Number(v);
const uid = ()=>Date.now().toString(36)+Math.random().toString(36).slice(2,5);
const esc = s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
/* Devuelve un fragmento DOM con `texto` en el que cada aparición (sin distinguir
   mayúsculas/acentos) de alguno de los `terminos` queda envuelta en <mark>.
   Construye los nodos con createElement/createTextNode: NUNCA usa innerHTML con
   el texto, así que es seguro ante XSS aunque el usuario escriba "<script>". */
function resaltarCoincidencias(texto, terminos){
  const frag = document.createDocumentFragment();
  const s = String(texto==null?"":texto);
  /* Para que las posiciones del realce coincidan con la búsqueda, se comparan
     versiones normalizadas carácter a carácter; el recorte se hace sobre el
     texto ORIGINAL para no perder acentos ni mayúsculas al mostrarlo. */
  const norm = t=>t.normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase();
  const sNorm = norm(s);
  const marcas = new Array(s.length).fill(false);
  (terminos||[]).forEach(t=>{
    const tNorm = norm(String(t||"")).replace(/\s+/g," ").trim();
    if(!tNorm) return;
    let desde = 0, pos;
    while((pos = sNorm.indexOf(tNorm, desde)) !== -1){
      for(let i=pos;i<pos+tNorm.length;i++) marcas[i]=true;
      desde = pos + tNorm.length;
    }
  });
  /* Se agrupan tramos consecutivos con el mismo estado en texto o <mark>. */
  let i = 0;
  while(i < s.length){
    const marcado = marcas[i];
    let j = i;
    while(j < s.length && marcas[j] === marcado) j++;
    const trozo = s.slice(i, j);
    if(marcado){ const m=document.createElement("mark"); m.textContent=trozo; frag.appendChild(m); }
    else frag.appendChild(document.createTextNode(trozo));
    i = j;
  }
  return frag;
}

/* Debounce exclusivo del buscador del Historial (~200 ms). Guarda el temporizador
   para que solo la última tecla programe el filtrado. */
let _tHist = null;
function debounceHist(fn){
  clearTimeout(_tHist);
  _tHist = setTimeout(fn, 200);
}
const hoy = ()=>{const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10)};
/* Cada partida guarda los datos de identidad/cantidad (codigo, desc, fact, recib)
   y, desde el Paso 4, el conteo en anaquel SEPARADO por división:
   `realPV` (Piso de Ventas) y `realBR` (Bodega). `real` es la suma de ambas y se
   calcula solo (ver sumarReal()), para que el resto de la app (resultado, resumen,
   ajuste y PDF) siga trabajando con una única existencia total. */
const linea0 = ()=>({codigo:"",desc:"",fact:"",recib:"",realPV:"",realBR:"",real:""});
const blank = ()=>({id:uid(),fecha:hoy(),linea:"",proveedor:"",folio:"",encargado:"",verificador:"",partidas:[linea0()],paso:1,creado:Date.now()});
const dR = p=>num(p.recib)-num(p.fact);
/* Existencia real total = Piso de Ventas + Bodega. Se recalcula SIEMPRE desde las
   dos divisiones para que `real` nunca quede desincronizado. Si NINGUNA de las
   dos divisiones tiene captura (ambas "") el total queda "" (partida sin contar). */
function sumarReal(p){
  const pv = num(p && p.realPV), br = num(p && p.realBR);
  if(pv==null && br==null) return "";
  return String((pv||0)+(br||0));
}
const fmt = n=>n>0?"+"+n:String(n);
const cls = n=>n<0?"neg":n>0?"pos":"z";
/* Paso 5 (Existencia en SICAR) y su comparación "Dif. sistema" se eliminaron a
   propósito: el conteo en anaquel (Paso 4) es la última cantidad que se captura
   y la única que se compara contra lo facturado/recibido. No se conserva ningún
   campo `sicar` ni el delta real-SICAR, ni en pantalla, ni en el resumen, ni en
   el PDF. Un documento que venga de una versión anterior con "sicar":paso 5 se
   degrada solo (ver normalizar()). */
function resultado(p){
  const r=dR(p), t=[];
  if(r<0)t.push("Faltante en recepción"); if(r>0)t.push("Sobrante en recepción");
  return t.length?t.join(" / "):"Conforme";
}
/* Una auditoría está completa solo si tiene partidas y todas traen recibido y
   real capturados. Se protege contra documentos viejos sin "partidas":
   sin esta guarda, resumen() y el historial fallaban y la tabla salía vacía
   aunque sí hubiera registros guardados. */
const completa = a=>Array.isArray(a&&a.partidas)&&a.partidas.length>0&&
  a.partidas.every(p=>p&&p.recib!==""&&p.real!=="");
function resumen(list){
  let part=0,hall=0,falt=0,sobr=0,recib=0,real=0,realPV=0,realBR=0,fact=0;
  /* Se comprueba cada nivel: un documento antiguo sin "partidas" (o con una
     partida nula) hacía fallar esta función, y con ella el historial y el PDF. */
  (Array.isArray(list)?list:[]).forEach(a=>{
    (Array.isArray(a&&a.partidas)?a.partidas:[]).forEach(p=>{
      if(!p||p.recib===""||p.real==="")return;
      part++; if(resultado(p)!=="Conforme")hall++;
      const r=dR(p); if(r<0)falt+=-r; if(r>0)sobr+=r;
      fact+=num(p.fact)||0; recib+=num(p.recib)||0; real+=num(p.real)||0;
      /* Conteo separado por división: PV (Piso de Ventas) y BR (Bodega). */
      realPV+=num(p.realPV)||0; realBR+=num(p.realBR)||0;
    });
  });
  /* Totales para ajustar inventario. Solo tienen valor como ajuste cuando la
     recepción fue conforme: si Dif. recep. != 0, lo recibido no cuadra con la
     factura y la suma no debe usarse para mover existencias. */
  const recepcionConforme = (falt===0 && sobr===0);
  const totalAjuste = recib + real;
  return {aud:list.length,part,hall,falt,sobr,fact,recib,real,realPV,realBR,recepcionConforme,totalAjuste};
}

/* ===== Pasos, en el orden obligatorio de captura ===== */
/* Son CINCO pasos: el antiguo Paso 5 ("Existencia en SICAR") se eliminó, así que
   "Hallazgos y reporte" pasó de 6 a 5. Se usa una versión segura de las partidas:
   un documento abierto desde el historial puede no traerlas y estos predicados
   rompían la pantalla. */
const partidasSeguras = a=>Array.isArray(a&&a.partidas)?a.partidas:[];
const PASOS = [
  {t:"Datos de la factura", ok:a=>!!(a.fecha&&a.linea&&String(a.proveedor||"").trim()&&String(a.folio||"").trim()&&String(a.encargado||"").trim())},
  {t:"Partidas facturadas", ok:a=>{const ps=partidasSeguras(a);return ps.length>0&&ps.every(p=>p&&String(p.codigo||"").trim()&&String(p.desc||"").trim()&&num(p.fact)>0)}},
  {t:"Recepción física", ok:a=>{const ps=partidasSeguras(a);return ps.length>0&&ps.every(p=>p&&p.recib!=="")}},
  {t:"Conteo en anaquel", ok:a=>{const ps=partidasSeguras(a);return !!String(a.verificador||"").trim()&&ps.length>0&&ps.every(p=>p&&p.realPV!==""&&p.realBR!=="")}},
  {t:"Hallazgos y reporte", ok:()=>true}
];
const ULTIMO = PASOS.length; /* 5: se usa en las guardas de paso en lugar de un 6 fijo */
const puede = (a,n)=>PASOS.slice(0,n-1).every(p=>p.ok(a));

let A = blank(), vista = "nueva", msg = "";
/* Se activa si al normalizar hubo que recortar partidas sobrantes (>20). */
/* Tope de partidas por auditoría. DEBE coincidir con el tope de partidasValidas()
   en firestore.rules (mismo número de posiciones indexadas). */
const MAX_PARTIDAS = 70;
let avisoLimite = false;

/* Ajusta el documento al esquema que exigen las reglas de Firestore.
   Motivo: la app escribe con setDoc(), que REEMPLAZA el documento entero. Si al
   objeto le falta un campo (p. ej. una auditoría abierta desde el historial que
   se guardó con una versión anterior de la app, o un documento que no pasó por
   blank()), las reglas lo rechazan con permission-denied. Igual ocurre si un
   input type="number" entrega un valor fuera de lo previsto. Se normaliza aquí,
   en un solo punto, para que guardar() siempre envíe algo válido. */
function normalizar(a){
  const txt = (v,n)=>String(v==null?"":v).slice(0,n);
  const cantidad = v=>{
    /* Las reglas exigen TEXTO de máximo 12 caracteres en las cantidades
       (firestore.rules: `p.fact is string && p.fact.size() <= 12`).
       Si llegara un número (p. ej. de un input type="number" o de una extracción
       de factura), el documento entero se rechazaría con permission-denied.
       Por eso se convierte a texto SIEMPRE, sea cual sea el tipo de entrada. */
    if(typeof v === "number") return cantidadTexto(v);
    const s = String(v==null?"":v).trim();
    if(!s) return "";
    if(s.length <= 12) return s;
    const n = num(s);
    if(n == null || !isFinite(n)) return "";
    const f = String(n);
    return f.length <= 12 ? f : String(Math.trunc(n)).slice(0, 12);
  };
  a.id = txt(a.id, 60) || uid();
  a.fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(a.fecha||"")) ? a.fecha : hoy();
  a.linea = ["","Volkswagen","Chevrolet"].includes(a.linea) ? a.linea : "";
  a.folio = txt(a.folio, 60);
  a.proveedor = txt(a.proveedor, 120);
  a.encargado = txt(a.encargado, 120);
  a.verificador = txt(a.verificador, 120);
  /* El tope sale de PASOS.length (5) en lugar de un 6 escrito a mano: si se
     hubiera dejado el 6, un documento antiguo en el Paso 6 quedaría apuntando a
     un paso que ya no existe y la pantalla saldría en blanco. */
  a.paso = Math.min(ULTIMO, Math.max(1, Math.trunc(num(a.paso) || 1)));
  a.creado = Math.trunc(num(a.creado)) > 0 ? Math.trunc(num(a.creado)) : Date.now();
  /* Las reglas aceptan como máximo 20 partidas. Si un documento antiguo trajera
     más (o se abriera desde un JSON manipulado), slice(0,20) descartaría filas
     EN SILENCIO: el usuario creería haber guardado todo. Se avisa en lugar de
     perder datos a escondidas. */
  const filas = Array.isArray(a.partidas) && a.partidas.length ? a.partidas : [linea0()];
  if(filas.length > MAX_PARTIDAS) avisoLimite = true;
  /* Se escriben SIEMPRE los SEIS campos de la partida (codigo, desc, fact, recib,
     realPV, realBR, real), aunque el origen los traiga incompletos. Las reglas
     usan hasOnly() a nivel partida? No: solo validan que `partidas` sea lista de
     1..70, pero normalizar deja una forma consistente para toda la app.
     `real` se recalcula como realPV + realBR para que nunca quede desincronizado;
     un documento viejo con `real` pero sin las divisiones conserva su total en PV
     (no se pierde el conteo ya capturado). El antiguo campo `sicar` NO se escribe. */
  a.partidas = filas.slice(0, MAX_PARTIDAS).map(p=>{
    const realPV = cantidad(p && p.realPV);
    const realBR = cantidad(p && p.realBR);
    /* Documento de la versión anterior (solo `real`, sin divisiones): se migra
       poniendo el total en PV para no perder el conteo que ya estaba capturado. */
    const migrado = realPV==="" && realBR==="" && cantidad(p && p.real)!=="";
    const fila = {
      codigo: txt(p && p.codigo, TOPE_CODIGO),
      desc:   txt(p && p.desc, TOPE_DESC),
      fact:   cantidad(p && p.fact),
      recib:  cantidad(p && p.recib),
      realPV: migrado ? cantidad(p && p.real) : realPV,
      realBR: realBR,
    };
    fila.real = sumarReal(fila);
    return fila;
  });
  return a;
}

/* ¿El documento cumple ya el esquema que exigen las reglas de Firestore?
   Las reglas rechazan cualquier partida con codigo vacío, así que una auditoría
   recién abierta (con la fila en blanco) todavía NO se puede guardar.
   Se replica aquí ese mínimo para avisar antes de intentar la escritura,
   incluyendo los topes de longitud de codigo (60) y desc (300).
   OJO: `linea` puede ser "" (contenidoValido() acepta ['', 'Volkswagen',
   'Chevrolet']); exigirla con texto bloquearía auditorías que Firestore SÍ
   aceptaría. Solo se comprueba que sea uno de los valores permitidos. */
function guardable(a){
  if(!a || !a.fecha || !["","Volkswagen","Chevrolet"].includes(a.linea)
     || !String(a.proveedor||"").trim()) return false;
  const ps = Array.isArray(a.partidas)?a.partidas:[];
  if(!ps.length || ps.length > MAX_PARTIDAS) return false;
  /* Toda partida debe tener código y descripción con texto dentro de los topes,
     y cantidad > 0. Coincide con partidaValida() de firestore.rules. */
  return ps.every(p=>p
    && String(p.codigo||"").trim() && String(p.codigo||"").length <= TOPE_CODIGO
    && String(p.desc||"").trim() && String(p.desc||"").length <= TOPE_DESC
    && num(p.fact) > 0);
}

/* ¿Se puede GUARDAR MIENTRAS SE CAPTURA? Versión laxa de guardable().
   Motivo: una auditoría recién empezada todavía no tiene partidas capturadas
   (con la fila en blanco inicial, que el propio blank() crea a propósito), así
   que guardable() da false y el Paso 1 nunca se persistía. Consecuencia real:
   el folio NO aparecía en el historial y era imposible retomarlo más tarde.
   El único requisito que las reglas imponen de verdad para el borrador es que
   `codigo` (uno de los cinco campos, con hasOnly) esté PRESENTE aunque vaya
   vacío: parte de `^[\\s\\S]{1,60}$` a `{0,60}` justo para permitir la fila
   recién creada (ver partidaValida() en firestore.rules). */
function guardableBorrador(a){
  const ps = Array.isArray(a&&a.partidas)?a.partidas:[];
  if(!ps.length || ps.length > MAX_PARTIDAS) return false;
  return ps.every(p=>p
    && String(p.codigo??"").length <= TOPE_CODIGO
    && String(p.desc??"").length   <= TOPE_DESC
    /* Las cantidades NO pueden quedar en notación larga: las reglas
       aceptan máximo 12 caracteres y el documento completo se rechazaría. */
    && String(p.fact??"").length  <= 12
    && String(p.recib??"").length <= 12
    && String(p.real??"").length  <= 12
    && String(p.realPV??"").length <= 12
    && String(p.realBR??"").length <= 12);
}

async function guardar(){
  avisoLimite = false;
  A = normalizar(A);
  A.paso = Math.max(A.paso, 1);
  /* Sin sesión no se puede escribir: las reglas exigen uid y email del token.
     Se avisa una sola vez y se evita el permission-denied confuso. */
  if(cloud && !usuario) return false;
  /* Trazabilidad: quién capturó y cuándo, para que un reporte no se pueda atribuir a otro. */
  if(usuario){ A.uid = usuario.uid; A.email = usuario.email || ""; }
  A.actualizado = Date.now();
  /* Se omite la escritura mientras el documento no cumpla el esquema: si se
     enviara, las reglas lo rechazarían con permission-denied y el usuario vería
     un error que en realidad solo significa "aún no termino de capturar".
     Se acepta el BORRADOR (mientras se captura) para que cada folio quede en
     Firestore desde el Paso 1: así aparece en el historial y se puede retomar
     después, aunque todavía no tenga partidas con código. */
  if(!guardable(A) && !guardableBorrador(A)) return false;
  await store.save(JSON.parse(JSON.stringify(A)));
  /* Se recuerda la huella de lo que acaba de quedar a salvo: es lo que apaga el
     aviso de "Avance todavía sin guardar" y lo que evita ofrecer guardar dos veces
     el mismo folio al pulsar "Empezar otro folio". */
  A.hist = huella(A);
  /* Si hubo que descartar filas sobrantes, se informa: el guardado fue exitoso
     pero incompleto, y el usuario debe saberlo. */
  if(avisoLimite) msg = "Se guardaron las primeras " + MAX_PARTIDAS + " partidas: el límite por auditoría es " + MAX_PARTIDAS + ". Las demás no se almacenaron.";
  return true;
}

/* ===== Autoguardado =====
   Guardado automático tras CADA cambio, para que cerrar la pestaña por error (o
   quedarse sin batería) no borre el conteo ya trabajado. Tres capas:
     1) Copia local inmediata (localStorage): síncrona, nunca falla ni espera a la
        red. Es el respaldo de emergencia de este navegador.
     2) Escritura a Firestore con RETARDO (debounce): agrupa ráfagas de tecleo en
        una sola escritura, para no castigar la red ni las cuotas.
     3) Guardado al abandonar la página (cambiar de pestaña o cerrarla).
   El autoguardado NUNCA molesta con diálogos ni pierde el foco: solo actualiza el
   indicador de estado. Los guardados explícitos (avanzar de paso, botones) siguen
   igual y comparten la misma huella (`A.hist`). */
const AUTOGUARDADO_MS = 900;   /* espera tras la última tecla */
let autoguardadoTimer = null;  /* debounce de la escritura remota */
let autoguardando = false;     /* hay una escritura en curso */
let autoguardadoMsg = "";      /* texto del indicador ("Guardando…", "Guardado 10:32"…) */
const AUTOGUARDADO_COL = COL + "_borrador"; /* clave local del borrador de emergencia */

/* Copia local inmediata del folio en curso. Se guarda BAJO la clave del borrador
   (no en la lista principal) para no mezclar borradores de emergencia con las
   auditorías: al reabrir la app se ofrece recuperarlo. */
function respaldoLocal(){
  try{
    if(!hayAvance(A)){ localStorage.removeItem(AUTOGUARDADO_COL); return; }
    localStorage.setItem(AUTOGUARDADO_COL, JSON.stringify(JSON.parse(JSON.stringify(A))));
  }catch(err){ /* localStorage lleno o bloqueado: el respaldo remoto sigue en pie */ }
}

/* Guardado silencioso: misma validación que guardar(), pero sin diálogos. Devuelve
   true si el documento quedó a salvo (remoto) o si no había nada que guardar. */
async function autoguardar(){
  autoguardadoTimer = null;
  if(vista !== "nueva") return true;           /* en el historial no se captura */
  if(cloud && !usuario) return true;           /* sin sesión no hay escritura (ni error) */
  respaldoLocal();                              /* capa 1: respaldo local inmediato */
  if(!hayAvance(A)) return true;                /* nada que conservar todavía */
  if(huella(A) === A.hist) return true;         /* ya está a salvo: no se reescribe */
  /* Si todavía no cumple el esquema, el respaldo local ya conserva el avance y se
     intentará de nuevo en el siguiente cambio. */
  if(!guardable(A) && !guardableBorrador(A)) return true;
  autoguardando = true;
  autoguardadoMsg = "Guardando…";
  actualizarIndicador();
  try{
    const ok = await guardar();                 /* capa 2: escritura (Firestore o local) */
    autoguardadoMsg = ok ? `Guardado ${new Date().toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"})}`
                         : "Cambios pendientes";
    return ok;
  }catch(err){
    /* Un fallo de red no debe romper la captura: el respaldo local ya está hecho. */
    autoguardadoMsg = "Sin conexión: guardado local";
    return false;
  }finally{
    autoguardando = false;
    actualizarIndicador();
  }
}

/* Programa el autoguardado tras la última tecla (debounce). Los cambios se
   acumulan: si el usuario sigue escribiendo, se reinicia el contador. */
function programarAutoguardado(){
  respaldoLocal();                     /* respaldo local SIN esperar al debounce */
  if(autoguardadoTimer) clearTimeout(autoguardadoTimer);
  autoguardadoTimer = setTimeout(autoguardar, AUTOGUARDADO_MS);
}

/* Refresca SOLO el texto del indicador (sin repintar la pantalla ni perder el foco). */
function actualizarIndicador(){
  const el = document.getElementById("estadoGuardado");
  if(el) el.innerHTML = textoIndicador();
}
function textoIndicador(){
  if(autoguardando) return `<span class="guardado gu" role="status">● Guardando…</span>`;
  if(autoguardadoMsg) return `<span class="guardado ${/Sin conexión/.test(autoguardadoMsg)?"gn":"gk"}" role="status">${esc(autoguardadoMsg)}</span>`;
  if(huella(A) === A.hist && hayAvance(A)) return `<span class="guardado gk" role="status">✓ Guardado</span>`;
  return "";
}

/* Al abrir la app tras un cierre inesperado, si quedó un borrador local con avance
   (y en pantalla no hay nada nuevo capturado), se ofrece recuperarlo. Así el cierre
   de pestaña no pierde el conteo ni siquiera cuando la escritura remota no llegó. */
function recuperarBorrador(){
  try{
    if(hayAvance(A)) return;                 /* ya hay algo en pantalla: no se pisa */
    const crudo = localStorage.getItem(AUTOGUARDADO_COL);
    if(!crudo) return;
    const b = JSON.parse(crudo);
    if(!hayAvance(b)){ localStorage.removeItem(AUTOGUARDADO_COL); return; }
    const nombre = b.folio ? ` el folio ${b.folio}` : " una captura sin folio";
    if(!confirm(`Se encontró${nombre} sin terminar (se estaba guardando solo).\n\nAceptar = retomarlo donde quedó.\nCancelar = empezar en blanco (el borrador se descarta).`)){
      localStorage.removeItem(AUTOGUARDADO_COL);   /* el usuario decidió descartarlo */
      return;
    }
    A = normalizar(b);
    A.paso = Math.min(ULTIMO, Math.max(1, Math.trunc(num(A.paso)) || 1));
    msg = `Se recuperó${nombre} tal como quedó.`;
  }catch(err){ /* borrador ilegible: se ignora sin molestar */ }
}

/* ===== Render ===== */
function render(){
  if(cloud && !usuario) return; /* sin sesión no se pinta nada */
  $("#nNueva").classList.toggle("on",vista==="nueva");
  $("#nHist").classList.toggle("on",vista==="hist");
  if(vista==="hist") return renderHist();
  const n=A.paso;
  const steps = PASOS.map((p,i)=>{
    const k=i+1, ok=k<n&&p.ok(A);
    return `<button data-go="${k}" class="${k===n?"on":""} ${ok?"done":""}" ${puede(A,k)?"":"disabled"}><b>Paso ${k}</b>${p.t}</button>`;
  }).join("");
  $("#app").innerHTML = `<div class="steps">${steps}</div><div class="card">${paso(n)}</div>${msg?`<div class="msg">${esc(msg)}</div>`:""}`;
  msg="";
}

function paso(n){
  const filas = f=>partidasSeguras(A).map((p,i)=>f(p,i)).join("");
  /* `extra` va ANTES de "Guardar y continuar" a propósito: el botón que avanza de
     paso es siempre el último de la barra y no debe moverse de sitio entre pasos. */
  const nav = (extra="")=>`<div class="bar"><button class="btn sec" data-go="${n-1}" ${n===1?"disabled":""}>Anterior</button>${extra}<button class="btn" id="sig" ${PASOS[n-1].ok(A)?"":"disabled"}>Guardar y continuar</button></div>`;
  /* El botón para abrir otro folio se agrega a la barra ya construida y NO se
     ofrece en el Paso 1: ahí es donde el usuario ya está capturando el folio
     nuevo, así que el botón solo estorbaría. */
  /* El aviso de "sin guardar" y el botón de otro folio se agregan a la barra.
     El botón SÍ se ofrece también en el Paso 1: cuando la entrada del folio es
     MANUAL (no por XML/PDF), el encargado teclea el folio y necesita abrir el
     siguiente sin antes capturar todas las partidas. Como el folio solo se puede
     guardar una vez escrito, la condición de hayAvance() ya evita ofrecer un botón
     que no haría nada (en un folio recién abierto no aparece). */
  const navTodos = extra=>(vista==="hist" ? nav(extra) : nav(`<span class="avisoFolio"><span id="estadoGuardado" role="status" aria-live="polite" aria-atomic="true">${textoIndicador()}</span>${avisoSinGuardar()}</span>`+extra));
  if(n===1) return `<h2>Datos de la factura</h2>
    ${avisoSinGuardar()}
    <p class="hint">Captura primero los datos del documento que llegó con la mercancía.
    Si ya tienes el XML o el PDF de la factura, cárgalo aquí y el folio, el proveedor y la fecha se llenan solos;
    si la factura viene <strong>a mano</strong>, escribe el folio tal como aparece impreso.</p>
    <div class="card box-factura">
      <h2 class="h-tight">Traer datos de la factura (XML CFDI o PDF)</h2>
      <p class="hint mb-s">Toma <strong>folio, proveedor y fecha</strong> de la factura y, si es XML,
      también sus partidas. El archivo se lee <strong>solo en tu navegador</strong>: no se sube ni se guarda.</p>
      <div class="row">
        <input type="file" id="factura" accept=".xml,.pdf,application/xml,text/xml,application/pdf" class="inp-file">
        <button class="btn sec" id="limpiarFact" hidden>Descartar archivo</button>
      </div>
      <div id="facturaMsg"></div>
    </div>
    <div class="grid">
      <label>Fecha de recepción<input type="date" data-f="fecha" value="${esc(A.fecha)}"></label>
      <label>Línea<select data-f="linea"><option value="">Selecciona…</option>${["Volkswagen","Chevrolet"].map(l=>`<option ${A.linea===l?"selected":""}>${l}</option>`).join("")}</select></label>
      <label>Proveedor<input data-f="proveedor" value="${esc(A.proveedor)}"></label>
      <label>Folio de factura<input data-f="folio" value="${esc(A.folio)}"></label>
      <label>Encargado que recibe<input data-f="encargado" value="${esc(A.encargado)}"></label>
    </div>
    <p class="hint">¿Llegó otra factura? <strong>Empezar otro folio</strong> guarda esta en el historial
    (aparece como <strong>En captura</strong>) y abre la siguiente sin cerrar nada.</p>
    ${navTodos(botonOtroFolio())}`;
  if(n===2) return `<h2>Partidas de la factura</h2><p class="hint">Copia cada renglón tal como viene en la factura: código, descripción y cantidad facturada.</p>
    <div class="card box-factura">
      <h2 class="h-tight">Cargar factura (XML CFDI o PDF)</h2>
      <p class="hint mb-s">Extrae <strong>número de parte y cantidad</strong> automáticamente.
      El archivo se lee <strong>solo en tu navegador</strong>: no se sube ni se guarda en la base de datos,
      únicamente se registran las partidas que confirmes.</p>
      <div class="row">
        <input type="file" id="factura" accept=".xml,.pdf,application/xml,text/xml,application/pdf" class="inp-file">
        <button class="btn sec" id="limpiarFact" hidden>Descartar archivo</button>
      </div>
      <div id="facturaMsg"></div>
    </div>
    <div class="tw"><table><caption class="sr">Partidas de la factura</caption><tr><th scope="col">Código</th><th scope="col">Descripción</th><th scope="col" class="n">Cant. facturada</th><th scope="col"><span class="sr">Acciones</span></th></tr>
    ${filas((p,i)=>`<tr><td><input data-i="${i}" data-k="codigo" aria-label="Código de la partida ${i+1}" value="${esc(p.codigo)}"></td><td><input data-i="${i}" data-k="desc" aria-label="Descripción de la partida ${i+1}" value="${esc(p.desc)}"></td><td class="n"><input type="number" min="0" step="1" data-i="${i}" data-k="fact" aria-label="Cantidad facturada de la partida ${i+1}" value="${esc(p.fact)}"></td><td><button class="btn del" data-del="${i}" ${A.partidas.length<2?"disabled":""}>Quitar</button></td></tr>`)}
    </table></div><div class="bar"><button class="btn sec" id="add" ${A.partidas.length>=MAX_PARTIDAS?"disabled":""}>Agregar partida</button>${A.partidas.length>=MAX_PARTIDAS?`<span class="hint">Máximo ${MAX_PARTIDAS} partidas por auditoría.</span>`:""}${botonOtroFolio()}</div>${nav()}`;
  if(n===3) return `<h2>Recepción física</h2><p class="hint">Cuenta lo que realmente llegó, pieza por pieza, y captura la cantidad recibida de cada partida.</p>
    <div class="tw"><table><caption class="sr">Recepción física por partida</caption><tr><th scope="col">Código</th><th scope="col">Descripción</th><th scope="col" class="n">Facturada</th><th scope="col" class="n">Recibida</th><th scope="col" class="n">Diferencia</th></tr>
    ${filas((p,i)=>`<tr><td>${esc(p.codigo)}</td><td>${esc(p.desc)}</td><td class="n">${esc(p.fact)}</td><td class="n"><input type="number" min="0" step="1" data-i="${i}" data-k="recib" aria-label="Cantidad recibida de la partida ${i+1}" value="${esc(p.recib)}"></td><td class="n" data-d="${i}">${p.recib===""?"":`<span class="${cls(dR(p))}">${fmt(dR(p))}</span>`}</td></tr>`)}
    </table></div>${navTodos(botonOtroFolio())}`;
  if(n===4) return `<h2>Conteo en anaquel</h2><p class="hint">Lo hace el verificador, por separado del encargado. Las cantidades esperadas no se muestran para que el conteo sea independiente. Cuenta la existencia de cada código <strong>dividida por ubicación</strong>: las piezas del <strong>Piso de Ventas (PV)</strong> y las de la <strong>Bodega (BR)</strong>; el total se suma solo.</p>
    <div class="grid"><label>Verificador<input data-f="verificador" value="${esc(A.verificador)}"></label></div>
    <div class="tw"><table><caption class="sr">Conteo en anaquel por partida (PV y BR)</caption><tr><th scope="col">Código</th><th scope="col">Descripción</th><th scope="col" class="n">PV · Piso de Ventas</th><th scope="col" class="n">BR · Bodega</th><th scope="col" class="n">Total real</th></tr>
    ${filas((p,i)=>`<tr><td>${esc(p.codigo)}</td><td>${esc(p.desc)}</td><td class="n"><input type="number" min="0" step="1" data-i="${i}" data-k="realPV" aria-label="Existencia en Piso de Ventas de la partida ${i+1}" value="${esc(p.realPV)}"></td><td class="n"><input type="number" min="0" step="1" data-i="${i}" data-k="realBR" aria-label="Existencia en Bodega de la partida ${i+1}" value="${esc(p.realBR)}"></td><td class="n" data-t="${i}">${p.real===""?"":esc(p.real)}</td></tr>`)}
    </table></div>${navTodos(botonOtroFolio())}`;
  /* n===5 es AHORA la pantalla de hallazgos: el antiguo paso de captura de SICAR
     desapareció, así que no hay ningún bloque intermedio que devolver aquí. */
  const r=resumen([A]);
  return `<h2>Hallazgos de la auditoría</h2><p class="hint">Folio ${esc(A.folio)} · ${esc(A.proveedor)} · ${esc(A.linea)} · ${esc(A.fecha)}</p>
    <div class="kpis">
      <div class="kpi"><span>Partidas revisadas</span><strong>${r.part}</strong></div>
      <div class="kpi ${r.hall?"bad":"ok"}"><span>Con hallazgo</span><strong>${r.hall}</strong></div>
      <div class="kpi ${r.falt?"bad":"ok"}"><span>Piezas faltantes en recepción</span><strong>${r.falt}</strong></div>
      <div class="kpi"><span>Piezas sobrantes</span><strong>${r.sobr}</strong></div>
    </div>
    ${bloqueAjuste(r)}
    <div class="tw"><table><caption class="sr">Hallazgos y resultado por partida</caption><tr><th scope="col">Código</th><th scope="col">Descripción</th><th scope="col" class="n">Fact.</th><th scope="col" class="n">Recib.</th><th scope="col" class="n">Real PV</th><th scope="col" class="n">Real BR</th><th scope="col" class="n">Real total</th><th scope="col">Resultado</th></tr>
    ${filas(p=>`<tr class="${resultado(p)==="Conforme"?"":"hall"}"><td>${esc(p.codigo)}</td><td>${esc(p.desc)}</td><td class="n">${p.fact}</td><td class="n">${p.recib}</td><td class="n">${p.realPV===""?"—":p.realPV}</td><td class="n">${p.realBR===""?"—":p.realBR}</td><td class="n">${p.real}</td><td>${resultado(p)}</td></tr>`)}
    </table></div>
    <div class="bar"><button class="btn sec" data-go="4">Anterior</button><span class="row">${botonOtroFolio()}<button class="btn" id="pdf">Descargar PDF</button></span></div>`;
}

/* ¿Vale la pena guardar lo que hay en pantalla? Misma condición que usa el botón
   "Empezar otro folio": si el usuario no capturó NADA (la pantalla recién abierta,
   sin folio, sin proveedor y con la fila en blanco), no hay nada que guardar y no
   se le molesta con avisos ni con un botón que no haría nada.
   OJO con `linea`: blank() la deja en "", y como "" es un valor que las reglas
   aceptan, comprobarla como "capturada" marcaría avance en un folio vacío. */
function hayAvance(a){
  if(!a) return false;
  if(String(a.folio||"").trim() || String(a.proveedor||"").trim() || String(a.encargado||"").trim()
     || String(a.verificador||"").trim() || String(a.linea||"").trim()) return true;
  return partidasSeguras(a).some(p=>p && (p.codigo||p.desc||p.fact||p.recib||p.real));
}

/* Aviso de respaldo. Con el autoguardado encendido, el avance se conserva solo:
   una copia local queda al instante y la escritura remota se dispara con retardo.
   Por eso aquí NO se alarma con "se perderá el folio" (ya no es cierto). Solo se
   recuerda guardar cuando el documento todavía NO cumple el esquema (falta fecha,
   línea, proveedor o folio): hasta entonces no hay nada definitivo que confirmar. */
function avisoSinGuardar(){
  if(huella(A) === A.hist) return "";
  if(guardable(A) || guardableBorrador(A))
    return `<span class="avisoAuto" title="Se guarda solo mientras capturas">Si cierras ahora, tu avance queda a salvo.</span>`;
  return `<span class="avisoAuto pend" title="El folio aún no se puede guardar">Aún sin guardar: completa fecha, línea, proveedor y folio.</span>`;
}

/* Huella del avance capturado. Puede ser "optimista" (marcar algo como guardado
   que las reglas rechacen): en ese caso se pierde un aviso, nunca datos.
   En cambio, si dijera que NO hay cambios cuando sí los hay, el aviso de
   "sin guardar" se apagaría solo y el avance se perdería en silencio. */
function huella(a){
  return [a && a.folio, a && a.fecha, a && a.linea, a && a.proveedor,
          a && a.encargado, a && a.verificador, a && a.paso,
          /* Se incluyen los campos de la partida (ya sin `sicar`): si se dejara
             fuera alguno, capturarlo no cambiaría la huella y el aviso de
             "sin guardar" no aparecería (y el usuario perdería el dato al salir). */
          partidasSeguras(a).map(p=>[p&&p.codigo,p&&p.desc,p&&p.fact,p&&p.recib,p&&p.realPV,p&&p.realBR,p&&p.real].join("\u0001")).join("\u0002")
         ].join("\u0000");
}

/* Botón para abrir OTRO folio sin perder el que está en pantalla. Sirve tanto
   para la factura que llegó con XML/PDF como para la captura MANUAL: en ambos
   casos el folio ya escrito es el que se guarda y queda en el historial.
   NO se exige el documento completo (guardable()): eso era precisamente lo que
   dejaba folios sin ninguna forma de guardarlos. Basta el borrador, porque cada
   folio se guarda con su propio id y así se pueden llevar varios a la vez. */
function botonOtroFolio(){
  if(!hayAvance(A)) return "";
  /* Cuando ya hay folio escrito, el texto lo nombra: en la captura manual el
     encargado teclea varios folios seguidos y así confirma cuál se está guardando. */
  const f = String(A.folio||"").trim();
  return `<button class="btn sec" id="nuevoFolio" title="Guarda este folio en el historial como En captura y abre el siguiente">Empezar otro folio${f?` después de ${esc(f)}`:""}</button>`;
}

/* Diálogo con las salidas reales del encargado: dejar el folio actual a medias
   (queda en el historial) o retomar el que se quedó pendiente. Se usa <dialog>
   nativo en vez de confirm(): ahí solo caben dos botones y aquí se ofrecen hasta
   TRES caminos, y además el texto admite formato.
   Con varias facturas capturadas A MANO, el camino habitual es "Guardar y empezar
   otro": se teclea el folio de la siguiente sin salir de la pantalla. */
function elegirFolio(folioActual, pendiente, avance){
  return new Promise(resolver=>{
    const d = document.createElement("dialog");
    d.className = "dlg";
    d.innerHTML = `
      <h2>Empezar otro folio</h2>
      <p class="hint">${avance && folioActual ? `El folio <strong>${esc(folioActual)}</strong> está en pantalla.` : "El folio en pantalla ya se guardó."}</p>
      ${avance ? `<p>Se guarda tal como va y queda en el historial como <strong>En captura</strong>.
        Lo retomas cuando quieras con <strong>Reanudar</strong>: no se pierde nada y no hay que terminarlo ahora.
        Es el camino normal cuando llegan <strong>varias facturas capturadas a mano</strong>.</p>` : ""}
      <div class="bar">
        <button class="btn sec" data-x="cancelar">Mejor lo termino ahora</button>
        ${avance ? `<button class="btn sec" data-x="${pendiente ? "guardarPendiente" : "guardar"}">${pendiente ? "Guardar y seguir con el pendiente" : "Guardar y empezar otro"}</button>` : ""}
        ${pendiente ? `<button class="btn" data-x="retomar">Retomar ${esc(pendiente.folio||"el folio pendiente")}</button>` : ""}
        ${avance ? `<button class="btn" data-x="nuevo">Empezar uno nuevo en blanco</button>` : ""}
      </div>
      ${pendiente && pendiente.folio ? `<p class="hint">Pendiente en el servidor: <strong>${esc(pendiente.folio)}</strong> · ${esc(pendiente.proveedor||"sin proveedor")} · Paso ${esc(String(pendiente.paso||1))}</p>` : ""}
      ${pendiente && !avance ? `<p class="hint">También puedes empezar un folio en blanco desde <strong>Auditoría del día</strong>.</p>` : ""}`;
    document.body.appendChild(d);
    /* Un clic fuera del diálogo devuelve cancelar: nunca debe quedar la pantalla
       bloqueada esperando una decisión. */
    d.addEventListener("click", ev=>{ if(ev.target === d) resolver(cerrar(d, "cancelar")); });
    d.addEventListener("click", ev=>{
      const b = ev.target.closest && ev.target.closest("button[data-x]");
      if(!b) return;
      resolver(cerrar(d, b.dataset.x));
    });
    d.showModal();
  });
}
function cerrar(d, r){ try{ d.close(); }catch(err){} d.remove(); return r; }

/* Guarda el folio en pantalla y busca el borrador más antiguo que quedó a medias.
   Solo se consulta Firestore si hace falta (el historial ya trae la lista).
   Devuelve true si conviene que el usuario decida: hay algo en pantalla sin
   guardar, o hay otro folio "En captura" esperando a ser retomado. */
async function otroFolio(){
  const avance = hayAvance(A);
  /* `reabrible` filtra los documentos que de verdad se pueden retomar: los que
     tienen folio/proveedor/fecha y al menos una partida con código. Sin ese filtro
     aparecerían borradores inútiles (una fila vacía, sin folio que mostrar). */
  const reabrible = a=>a && a.id!==A.id && !completa(a) && (a.folio||a.proveedor||a.fecha)
    && String(a.paso||"").trim() && partidasSeguras(a).some(p=>p && (p.codigo||p.desc||p.fact));
  let lista = window._list;
  if(!Array.isArray(lista) || !lista.length){
    try{ lista = await store.all(); }catch(err){ lista = window._list; }
  }
  const pendiente = (Array.isArray(lista)?lista:[]).filter(reabrible)
    .sort((a,b)=>(a.actualizado||a.creado||0)-(b.actualizado||b.creado||0))[0] || null;
  /* Se recuerda cuál se ofreció retomar: con varios folios pendientes, el diálogo
     y el manejador del clic tienen que hablar del MISMO documento. */
  window._folioPendiente = pendiente ? pendiente.id : null;
  if(!avance && !pendiente) return false;
  return elegirFolio(avance ? A.folio : "", pendiente, avance);
}

/* Pone en pantalla un documento ya guardado. Se usa desde el historial
   (data-open) y desde el diálogo de "Empezar otro folio", para que el folio se
   retome EXACTAMENTE donde quedó: antes siempre abría en el Paso 1 aunque el
   documento estuviera capturado hasta el Paso 4. */
function elegirAbierto(a){
  if(!a){ msg="Esa auditoría ya no existe. Actualiza el historial."; return renderHist(); }
  A = normalizar(JSON.parse(JSON.stringify(a)));
  vista = "nueva";
  const p = Math.min(ULTIMO, Math.max(1, Math.trunc(num(A.paso))||1));
  A.paso = p;
  msg = p>1
    ? `Folio ${A.folio||"sin folio"} reabierto: continúa en el Paso ${p}, donde lo dejaste.`
    : `Folio ${A.folio||"sin folio"} reabierto.`;
  return render();
}

/* Bloque de totales para ajustar inventario.
   Se muestra el conteo total de Recibidos + Real, pero SOLO se presenta como
   cifra utilizable para ajuste si Dif. recep. no tiene diferencias. */
function bloqueAjuste(r){
  const filasTot = `<div class="tw"><table>
      <caption class="sr">Totales de la auditoría en piezas</caption>
      <tr><th scope="col">Concepto</th><th scope="col" class="n">Piezas</th></tr>
      <tr><td>Total facturado</td><td class="n">${r.fact}</td></tr>
      <tr><td>Total recibido</td><td class="n">${r.recib}</td></tr>
      <tr><td>Real en Piso de Ventas (PV)</td><td class="n">${r.realPV}</td></tr>
      <tr><td>Real en Bodega (BR)</td><td class="n">${r.realBR}</td></tr>
      <tr><td>Total real en anaquel (PV + BR)</td><td class="n">${r.real}</td></tr>
      <tr><td><strong>Recibido + Real (conteo total)</strong></td><td class="n"><strong>${r.totalAjuste}</strong></td></tr>
    </table></div>`;
  if(r.recepcionConforme){
    return `<div class="card v-ok">
      <h2>Conteo total para ajuste de inventario</h2>
      <p class="hint">La recepción fue <strong>conforme</strong>: Dif. recep. no presenta diferencias
      (sin faltantes ni sobrantes), por lo que el conteo es confiable como base del ajuste.</p>
      <div class="kpis">
        <div class="kpi ok"><span>Recibidos</span><strong>${r.recib}</strong></div>
        <div class="kpi ok"><span>+ Real</span><strong>${r.real}</strong></div>
        <div class="kpi ok"><span>Total para ajustar</span><strong>${r.totalAjuste}</strong></div>
      </div>
      ${filasTot}
      <p class="hint">Ajuste sugerido: fijar la existencia en <strong>${r.totalAjuste}</strong> piezas
      (real + recibido).</p>
    </div>`;
  }
  return `<div class="card v-bad">
    <h2>Conteo total no utilizable para ajuste</h2>
    <p class="hint">Dif. recep. <strong>sí tiene diferencias</strong>
    (faltantes: ${r.falt}, sobrantes: ${r.sobr}), así que lo recibido no cuadra con la factura
    y la suma <strong>no debe usarse</strong> para mover existencias hasta que se aclare la recepción.</p>
    ${filasTot}
    <p class="hint">Solo informativo. Resuelve primero la diferencia de recepción para que el conteo
    sea válido como ajuste.</p>
  </div>`;
}

async function renderHist(){
  /* Toda la vista depende de esta lectura. Si fallaba (reglas, red, sesión),
     la excepción escapaba y la pantalla quedaba sin pintar: parecía que no
     había nada guardado. Ahora se informa la causa real. */
  let list;
  try{
    list = await store.all();
  }catch(err){
    $("#app").innerHTML = `<div class="card"><h2>Historial y reportes</h2>
      <div class="msg msg-bad">No se pudo leer el historial:
      ${esc(err.message)}</div>
      <p class="hint">Si el problema persiste, verifica tu correo (Firebase → Authentication)
      y que sigas dentro con la misma cuenta que capturó las auditorías.</p></div>`;
    window._list = [];
    return;
  }
  list = (list||[]).sort((a,b)=>(b.fecha+b.creado).toString().localeCompare((a.fecha+a.creado).toString()));
  /* Se separa lo que sigue EN CAPTURA de lo terminado: el trabajo a medias es lo
     que hay que retomar, y antes se perdía entre los registros completos. */
  const enCaptura = list.filter(a=>!completa(a));
  const terminadas = list.filter(a=>completa(a));
  const filasDe = (arr, mapaPartidas)=>arr.map(a=>{
    /* Cada fila se pincha a sí misma: un documento antiguo con un campo
       faltante solo afecta su propia fila, no toda la tabla. */
    let html;
    try{
      const r=resumen([a]);
      html = `<tr><td>${esc(a.fecha)}</td><td>${esc(a.linea)}</td><td>${esc(a.folio)}${completa(a)?"":`<span class="avance">En captura · Paso ${Math.min(ULTIMO,Math.max(1,num(a.paso)||1))}</span>`}</td><td>${esc(a.proveedor)}</td><td class="n">${completa(a)?r.hall:"—"}</td><td class="row"><button class="btn ${completa(a)?"sec":""}" data-open="${esc(a.id)}">${completa(a)?"Abrir":"Reanudar"}</button><button class="btn sec" data-pdf="${esc(a.id)}" ${completa(a)?"":"disabled"}>PDF</button><button class="btn del" data-rm="${esc(a.id)}">Eliminar</button></td></tr>`;
    }catch(e){
      html = `<tr><td colspan="6">Registro con datos incompletos (id ${esc(a&&a.id)}). Ábrelo para corregirlo o elíminalo.</td></tr>`;
    }
    /* Fila extra SOLO si el filtro marcó partidas concretas de este registro. */
    const marcadas = mapaPartidas && mapaPartidas.get(a.id);
    if(marcadas && marcadas.length){
      html += `<tr class="fila-coincidencia"><td colspan="6"><span class="coincidencia-et">Coincide en:</span><ul class="coincidencia-lista" data-match="${esc(a.id)}"></ul></td></tr>`;
    }
    return html;
  }).join("");
  /* Etiqueta que da contexto al renglón: en la tabla plana anterior no se sabía
     si un hallazgo "0" era un conteo o una auditoría sin terminar. */
  const separador = t=>`<tr><td colspan="6" class="fila-sep">${t}</td></tr>`;
  /* Arma el conjunto de filas (con o sin filtro). `filtrado` es el resultado de
     buscarRegistros(): [{registro, partidas}]. Devuelve el HTML del tbody y un
     mapa id→[índices] con las partidas que coincidieron (para la fila extra). */
  const cuerpoDe = filtrado=>{
    const enFiltro = new Set(filtrado.map(x=>x.registro));
    const captura = enCaptura.filter(a=>enFiltro.has(a));
    const term = terminadas.filter(a=>enFiltro.has(a));
    if(!filtrado.length){
      return {html:`<tr><td colspan="6">Ningún registro coincide con la búsqueda. Prueba con otra palabra, otro día o borra el texto.</td></tr>`, mapa:new Map()};
    }
    const mapa = new Map();
    filtrado.forEach(x=>{ if(x.partidas && x.partidas.length) mapa.set(x.registro.id, x.partidas); });
    const html = (captura.length?separador(`En captura — retómalas donde las dejaste (${captura.length})`)+filasDe(captura, mapa):"")
      + (term.length?separador(`Terminadas (${term.length})`)+filasDe(term, mapa):"");
    return {html: html || `<tr><td colspan="6">Aún no hay auditorías. Empieza una desde “Auditoría del día”.</td></tr>`, mapa};
  };
  $("#app").innerHTML = `<div class="card"><h2>Historial y reportes</h2>
    <p class="hint mb-10">Puedes trabajar en varios folios a la vez: deja uno a medias,
    empieza el siguiente y vuelve después con <strong>Reanudar</strong>. Cada avance de paso se guarda solo.</p>
    <div class="row row-h"><label>Reporte del día<input type="date" id="dia" value="${hoy()}"></label><button class="btn" id="pdfDia">Descargar PDF del día</button><button class="btn sec" id="nuevaDesdeHist">Empezar auditoría nueva</button></div>
    <div class="buscador">
      <label class="sr" for="buscarHist">Buscar en el historial</label>
      <input type="search" id="buscarHist" class="buscador-input" placeholder="Buscar por proveedor, folio, fecha o artículo…" autocomplete="off" aria-describedby="buscarCuenta">
      <button type="button" class="btn sec" id="limpiarHist" hidden>Limpiar</button>
      <span id="buscarCuenta" class="buscador-cuenta" role="status" aria-live="polite" aria-atomic="true"></span>
    </div>
    <p class="hint mb-10">Al abrir una auditoría puedes capturar el folio <strong>a mano</strong> o cargar el <strong>XML/PDF</strong> de la factura.</p>
    <div class="tw"><table><caption class="sr">Historial de auditorías</caption><thead><tr><th scope="col">Fecha</th><th scope="col">Línea</th><th scope="col">Folio</th><th scope="col">Proveedor</th><th scope="col" class="n">Hallazgos</th><th scope="col"><span class="sr">Acciones</span></th></tr></thead>
    <tbody id="histCuerpo"></tbody>
    </table></div></div>${msg?`<div class="msg">${esc(msg)}</div>`:""}`;
  /* Repinta SOLO el cuerpo de la tabla y el contador. Así el input no pierde el
     foco mientras el usuario escribe (no se reconstruye toda la tarjeta). */
  const pintarCuerpo = texto=>{
    const filtrado = buscarRegistros(list, texto);
    const {html, mapa} = cuerpoDe(filtrado);
    /* Los términos (ya normalizados) se usan para realzar con <mark>. */
    const terminos = String(texto||"").split(/\s+/).filter(Boolean);
    const tbody = document.getElementById("histCuerpo");
    if(tbody) tbody.innerHTML = html;
    /* La fila extra de partidas NO lleva texto del usuario en innerHTML: los
       nodos se arman aquí con textContent/<mark> (resaltarCoincidencias). */
    if(tbody) tbody.querySelectorAll("ul[data-match]").forEach(ul=>{
      const idxs = mapa.get(ul.dataset.match) || [];
      const reg = list.find(x=>x.id===ul.dataset.match);
      if(!reg) return;
      idxs.forEach(i=>{
        const p = (reg.partidas||[])[i]; if(!p) return;
        const li = document.createElement("li");
        const cod = document.createElement("strong");
        cod.appendChild(resaltarCoincidencias(p.codigo||"", terminos));
        if(p.codigo) cod.appendChild(document.createTextNode(" · "));
        li.appendChild(cod);
        li.appendChild(resaltarCoincidencias(p.desc||"", terminos));
        if(p.fact !== "" && p.fact != null){
          const cant = document.createElement("span");
          cant.className = "coincidencia-cant";
          cant.appendChild(document.createTextNode(" (fact. "));
          cant.appendChild(resaltarCoincidencias(p.fact, terminos));
          cant.appendChild(document.createTextNode(")"));
          li.appendChild(cant);
        }
        ul.appendChild(li);
      });
    });
    const cuenta = document.getElementById("buscarCuenta");
    if(cuenta){
      cuenta.textContent = texto
        ? `${filtrado.length} de ${list.length} registro${list.length===1?"":"s"}`
        : "";
    }
    const btn = document.getElementById("limpiarHist");
    if(btn) btn.hidden = !texto;
  };
  /* Estado inicial (sin filtro): se pinta todo el cuerpo una vez. */
  pintarCuerpo("");
  /* Al pintar de cero, el input arranca vacío; se enfoca para operar con teclado. */
  window._histLista = list;
  window._histPintar = pintarCuerpo;
  window._list = list; msg="";
}

/* ===== Eventos ===== */
document.addEventListener("input",e=>{
  const t=e.target;
  /* --- Súper buscador del Historial --- */
  if(t.id==="buscarHist"){
    /* Debounce ~200 ms: no filtra en cada tecla sino cuando el usuario pausa,
       y solo repinta el cuerpo de la tabla (el input conserva el foco). */
    debounceHist(()=>{ if(window._histPintar) window._histPintar(t.value); });
    return;
  }
  if(t.dataset.f){ A[t.dataset.f]=t.value; }
  else if(t.dataset.k){
    A.partidas[+t.dataset.i][t.dataset.k]=t.value;
    const p=A.partidas[+t.dataset.i];
    /* Conteo en anaquel dividido: al editar PV o BR se recalcula la existencia
       total (`real`) y se refresca solo su celda, sin repintar toda la pantalla
       para no perder el foco del campo que se está escribiendo. */
    if(t.dataset.k==="realPV" || t.dataset.k==="realBR"){
      p.real=sumarReal(p);
      const c=document.querySelector(`[data-t="${t.dataset.i}"]`); if(c) c.textContent=p.real===""?"":p.real;
    }
    if(t.dataset.k==="recib"){const c=document.querySelector(`[data-d="${t.dataset.i}"]`);if(c)c.innerHTML=p.recib===""?"":`<span class="${cls(dR(p))}">${fmt(dR(p))}</span>`;}
  } else return;
  const s=$("#sig"); if(s) s.disabled=!PASOS[A.paso-1].ok(A);
  /* Autoguardado: cada tecla/valor dispara (con retardo) la escritura, para que
     cerrar la pestaña nunca pierda lo capturado. */
  programarAutoguardado();
});

/* Aviso de folio duplicado mientras se teclea (no en cada tecla: solo cuando el
   campo pierde el foco). Aquí NO se consulta Firestore para no castigar la red
   en un evento de formulario: se usa la lista que ya trajo el historial. Si el
   usuario abrió el historial, la comprobación es exacta. */
document.addEventListener("focusout", async e=>{
  const t = e.target;
  if(!t || t.dataset.f !== "folio") return;
  if(!String(A.folio||"").trim()) return;
  if(!Array.isArray(window._list) || !window._list.length) return;
  const f = String(A.folio).trim().toLowerCase();
  const previo = window._list.find(x=>x && x.id !== A.id && String(x.folio||"").trim().toLowerCase() === f);
  if(!previo) return;
  /* Se evita repetir el mismo aviso en cada salida del campo. */
  if(window._folioAvisado === A.id + "|" + f) return;
  window._folioAvisado = A.id + "|" + f;
  msg = `El folio ${A.folio} ya está capturado (${previo.fecha} · ${previo.proveedor||"sin proveedor"}). Si es la misma factura, ábrela desde el historial en lugar de duplicarla.`;
  render();
});
document.addEventListener("change", async e=>{
  const t = e.target;
  /* Campos del formulario y de las tablas: algunos navegadores no emiten `input`
     para <select> ni rellenando fecha con el calendario. Se programa aquí el
     autoguardado para no perder ese cambio (los campos data-f de la cabecera y
     los data-k de las partidas). En modo historial no se captura, así que se ignora. */
  if(vista === "nueva" && t && !t.dataset.go && (t.dataset.f || t.dataset.k)){
    programarAutoguardado();
  }
  /* Al salir del Paso 1 se guarda el folio SOLO: es el momento en que el usuario
     ya tiene los datos de la factura y lo más probable es que continúe después.
     Si esto se dejara al "Guardar y continuar", cerrar la pestaña aquí perdía el
     folio entero. Solo aplica a la pantalla de captura (vista "nueva"): en el
     historial el mismo id de campo aparece en los filtros del reporte, y no debe
     dispararse un guardado desde ahí. */
  if(t.dataset && t.dataset.go !== undefined && t.dataset.f && vista === "nueva"){
    const k = +t.dataset.go;
    /* El tope sale del número de pasos (5) y no de un 6 fijo: con el 6 se seguiría
       aceptando un salto a un paso que ya no existe. */
    if(k >= 1 && k <= ULTIMO && puede(A,k) && A.paso !== k){
      const anterior = A.paso;
      A.paso = k;
      /* `guardar()` no lanza: devuelve false cuando el documento todavía no cumple
         el esquema. Aquí no se avisa nada: el aviso de "sin guardar" del Paso 1 ya
         lo explica, y el usuario no pidió guardar todavía. */
      if(!await guardar()) A.paso = anterior;
    }
    return;
  }
  if(t.id !== "factura") return;
  /* El mismo id de archivo existe en el Paso 1 y en el Paso 2: se ignora si el
     control no está realmente en pantalla (restos de otra vista) para no mezclar
     la extracción de partidas con la de cabecera. */
  if(!t.isConnected) return;
  const archivo = t.files && t.files[0];
  if(!archivo) return;
  const caja = document.getElementById("facturaMsg");
  if(caja) caja.innerHTML = `<div class="msg">Leyendo <strong>${esc(archivo.name)}</strong>…</div>`;
  const bLimpiar = document.getElementById("limpiarFact");
  if(bLimpiar) bLimpiar.hidden = false;
  try{
    /* El archivo se procesa en memoria; en ningún momento se sube a un servidor. */
    const res = await leerFactura(archivo);
    /* Se emparejan los datos de cabecera del CFDI con el formulario.
       IMPORTANTE: además de asignarlos a `A`, hay que REFLEJARLOS en los campos
       del Paso 1. Antes solo se cambiaba `A` y el usuario veía los inputs vacíos:
       parecía que la lectura no había servido de nada hasta cambiar de paso. */
    const cab = res.cabecera || {};
    let aplicados = [];
    if(cab.folio && !A.folio){ A.folio = cab.folio; aplicados.push("folio"); }
    if(cab.proveedor && !A.proveedor){ A.proveedor = cab.proveedor; aplicados.push("proveedor"); }
    if(cab.fecha && (!A.fecha || A.fecha===hoy())){ A.fecha = cab.fecha; aplicados.push("fecha"); }
    pintarExtraccion(res, archivo.name);
    /* El folio real de la factura no debe capturarse dos veces: si ya existe una
       auditoría con ese folio, casi siempre es un duplicado (y un ajuste de
       inventario aplicado dos veces). Se avisa aquí, al leer el archivo. */
    if(aplicados.includes("folio")) await revisarFolioDuplicado();
    pintarCabecera(aplicados);
    /* Se informa DE DÓNDE salió cada dato: si el folio vino del UUID del timbre
       (y no del número impreso en el papel) o si la fecha es la de emisión y no
       la de recepción, el usuario debe verlo antes de seguir capturando. */
    const detalles = [];
    /* cab.folioOrigen y cab.fecha vienen del CFDI (archivo del usuario) y este
       texto se inserta con insertAdjacentHTML más abajo: se escapan aquí para
       no inyectar HTML desde el archivo cargado. */
    if(aplicados.includes("folio") && cab.folioOrigen) detalles.push(`el folio salió de «${esc(cab.folioOrigen)}»`);
    if(aplicados.includes("fecha") && cab.fecha) detalles.push(`la fecha (${esc(cab.fecha)}) es la de emisión del CFDI: cámbiala si la mercancía llegó otro día`);
    if(aplicados.length){
      const c2 = document.getElementById("facturaMsg");
      if(c2) c2.insertAdjacentHTML("afterbegin",
        `<div class="msg msg-ok">También se tomaron del CFDI: ${aplicados.join(", ")}.
        Verifícalos en el Paso 1${detalles.length?` — ${detalles.join("; ")}`:""}.</div>`);
    }
  }catch(err){
    if(caja) caja.innerHTML = `<div class="msg">No se pudo leer el archivo: ${esc(err.message||err)}</div>`;
  }finally{
    /* Se limpia el input para que el archivo deje de estar referenciado. */
    t.value = "";
    /* Los datos tomados del CFDI (folio/proveedor/fecha o partidas) se guardan solos. */
    if(vista === "nueva") programarAutoguardado();
  }
});

/* El botón "Limpiar" del buscador del Historial: borra el texto, repinta y
   devuelve el foco al campo. Va en su propio listener (síncrono) para no entrar
   en la cadena async del listener de acciones, que hace `return` con mensajes. */
document.addEventListener("click",e=>{
  const b=e.target.closest("#limpiarHist"); if(!b) return;
  const inp=document.getElementById("buscarHist");
  if(inp){ inp.value=""; inp.focus(); }
  if(window._histPintar) window._histPintar("");
});
/* Esc dentro del buscador: limpia el texto sin salir de la vista (Gestalt de
   "escapar cancela la búsqueda"). */
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape") return;
  const inp=e.target && e.target.id==="buscarHist" ? e.target : null;
  if(!inp || !inp.value) return;
  inp.value="";
  if(window._histPintar) window._histPintar("");
});
document.addEventListener("click",async e=>{
  const b=e.target.closest("button"); if(!b) return;
  try{
    if(b.id==="aplicarFact"){
      const n = aplicarExtraccion();
      facturaPendiente = null;
      msg = n ? `Se cargaron ${n} partidas desde la factura. No se guardó ninguna copia del archivo.`
              : "No se cargó ninguna partida: revisa que el código y la cantidad sean válidos.";
      programarAutoguardado();  /* las partidas cargadas se conservan aunque se cierre la pestaña */
      return render();
    }
    if(b.id==="cancelarFact" || b.id==="limpiarFact"){
      facturaPendiente = null;
      msg = "Archivo descartado. No se guardó nada.";
      return render();
    }
    if(b.id==="nNueva"){vista="nueva";return render();}
    /* Empezar una auditoría desde el historial: evita el viaje por la pestaña
       "Auditoría del día" cuando el encargado ya está trabajando en el historial.
       Si hay un folio a medias en pantalla, se pasa por el mismo diálogo del botón
       "Empezar otro folio" para no perderlo en silencio. */
    if(b.id==="nuevaDesdeHist"){
      if(vista!=="nueva" || !hayAvance(A)){ A = blank(); msg = ""; vista = "nueva"; return render(); }
      const r = await otroFolio();
      if(r === "cancelar") return renderHist();
      if(r === "retomar" || r === "guardarPendiente"){
        if(r === "guardarPendiente" && !await guardar()){ msg = "No se guardó el folio: revisa fecha, línea, proveedor y folio."; return renderHist(); }
        const l = (window._list||[]).find(x=>x.id===window._folioPendiente) || null;
        if(!l){ msg = "Ese folio ya no está disponible."; return renderHist(); }
        return elegirAbierto(l);
      }
      if(r === "nuevo" || r === false){
        if(hayAvance(A) && !await guardar()){ msg = "No se guardó el folio: revisa fecha, línea, proveedor y folio."; return renderHist(); }
        A = blank(); msg = ""; vista = "nueva"; return render();
      }
      /* Guardar y empezar otro: el folio en pantalla se guarda y se abre uno nuevo. */
      if(!await guardar()){ msg = "No se guardó el folio: revisa fecha, línea, proveedor y folio."; return renderHist(); }
      A = blank(); msg = "Folio guardado en el historial. Captura el siguiente."; vista = "nueva"; return render();
    }
    if(b.id==="nHist"){vista="hist";return render();}
    if(b.dataset.go){const k=+b.dataset.go;if(k>=1&&puede(A,k)){A.paso=k;return render();}}
    if(b.id==="add"){
      if(A.partidas.length<MAX_PARTIDAS) A.partidas.push(linea0());
      else msg="El límite es "+MAX_PARTIDAS+" partidas por auditoría.";
      return render();
    }
    if(b.dataset.del){A.partidas.splice(+b.dataset.del,1);return render();}
    if(b.id==="sig"){
      const anterior = A.paso;
      A.paso=Math.min(ULTIMO,A.paso+1);
      /* Al avanzar de paso se intenta persistir el avance; si el documento aún no
         cumple el esquema (p. ej. paso 1 sin partidas capturadas) no es un error,
         solo significa que todavía no hay nada que guardar.
         Como el borrador ya SÍ se guarda, el avance de cada folio queda en
         Firestore y se puede dejar a medias y retomar después. */
      const guardado = await guardar();
      msg = guardado
        ? `Avance guardado. Puedes empezar otro folio cuando quieras: este quedará en el historial como “En captura · Paso ${A.paso}”.`
        : (anterior>=2
            ? "No se guardó el avance: revisa que cada partida tenga código, descripción y cantidad facturada."
            : "Avance sin guardar todavía: completa fecha, línea, proveedor y folio.");
      return render();
    }
    if(b.id==="nuevo"){A=blank();msg="";return render();}
    /* Empezar otro folio sin perder el que está en pantalla. Los tres caminos
       comparten el mismo guardado: el borrador se persiste con su propio id, así
       que se pueden llevar varios folios a la vez. */
    if(b.id==="nuevoFolio"){
      const r = await otroFolio();
      /* Sin avance que guardar y sin pendientes: no hay nada que decidir y se
         responde con la misma acción del botón anterior ("Nueva auditoría"). */
      if(r === false){ A=blank(); return render(); }
      if(r === "cancelar") return;
      if(r === "nuevo"){
        if(hayAvance(A)){ const ok = await guardar(); if(!ok) return; }
        A = blank();
        msg = "Empezando en blanco. El folio anterior quedó guardado en el historial.";
        return render();
      }
      if(r === "retomar"){
        /* El folio actual sigue en pantalla y SIN guardar: no se pisa en silencio.
           Si el guardado no procede (documento que las reglas rechazarían), se
           pregunta antes de perder el avance. */
        if(hayAvance(A)){
          const ok = await guardar();
          if(!ok && !confirm("El folio en pantalla no se puede guardar todavía (revisa fecha, línea, proveedor y folio).\n\nSi abres el folio pendiente, este avance se perderá.\n¿Continuar de todos modos?")) return;
        }
        if(window._folioPendiente){
          const l = (window._list||[]).find(x=>x.id===window._folioPendiente) || null;
          if(!l){ msg = "Ese folio ya no está disponible. Actualiza el historial."; return render(); }
          return elegirAbierto(l);
        }
        /* Sin documento localizable, se abre el historial: ahí está el botón
           *Reanudar* de cada folio en captura, con el paso donde quedó. */
        msg = "Elige el folio que quieres retomar en el historial.";
        vista = "hist";
        return render();
      }
      /* "Guardar y empezar otro" o "Guardar y seguir con el pendiente": en los dos
         casos el folio en pantalla se guarda; en el segundo, además se abre el
         pendiente. Si el guardado no procede se avisa, en lugar de abrir un folio
         en blanco como si el anterior estuviera a salvo. */
      const ok = await guardar();
      if(!ok){
        msg = "No se guardó el folio: revisa fecha, línea, proveedor y folio.";
        return render();
      }
      if(r === "guardarPendiente"){
        /* El avance ya quedó a salvo: ahora se puede abrir el pendiente sin riesgo. */
        const l = (window._list||[]).find(x=>x.id===window._folioPendiente) || null;
        if(!l){ msg = "Ese folio ya no está disponible. Actualiza el historial."; return render(); }
        return elegirAbierto(l);
      }
      A = blank();
      msg = "Folio guardado en el historial. Captura el siguiente: el anterior sigue disponible.";
      return render();
    }
    if(b.id==="pdf"){
      /* Antes de generar el reporte se persiste; si el documento no cumple el
         esquema se avisa y no se produce un PDF incompleto que parezca válido. */
      const guardado = await guardar();
      if(!guardado){ msg = "Para generar el reporte, completa fecha, línea, proveedor y al menos una partida con código, descripción y cantidad facturada."; return render(); }
      return crearPDF([A],`Folio ${A.folio} · ${A.proveedor}`);
    }
    if(b.dataset.open){
      /* Si el registro ya no existe en la lista (lo borró otro usuario mientras
         esta pantalla estaba abierta), find() devuelve undefined y todo el
         render fallaría. Se avisa en vez de dejar la pantalla en blanco. */
      const encontrado = (window._list||[]).find(x=>x.id===b.dataset.open);
      if(!encontrado){ msg="Esa auditoría ya no existe. Actualiza el historial."; return renderHist(); }
      /* Si ya había otro folio a medias en pantalla, se avisa antes de pisarlo:
         el avance del folio actual ya está guardado (se persiste en cada paso),
         pero conviene que el usuario lo sepa y pueda volver con "Reanudar". */
      const enPantalla = vista==="nueva" && A && A.id !== encontrado.id && hayAvance(A);
      if(enPantalla && !confirm(`Tienes otro folio abierto${A.folio?` (${A.folio})`:` (${A.proveedor||"sin folio"})`} sin terminar.\n\n¿Quieres guardar su avance antes de abrir ${encontrado.folio||"la auditoría seleccionada"}?\n\nAceptar = guardar el avance y abrir la otra.\nCancelar = abrir la otra sin guardar (el avance en pantalla se pierde).`)){
        /* Cancelar ya NO significa "no hacer nada": antes el botón *Reanudar* no
           hacía absolutamente nada si el usuario cancelaba, y parecía roto. */
        msg = "No se abrió nada. El folio en pantalla sigue tal como lo tenías; si quieres conservarlo, pulsa Guardar y continuar.";
        return render();
      }
      if(enPantalla) await guardar();
      return elegirAbierto(encontrado);
    }
    if(b.dataset.pdf){
      const a=(window._list||[]).find(x=>x.id===b.dataset.pdf);
      if(!a){ msg="Esa auditoría ya no existe. Actualiza el historial."; return renderHist(); }
      if(!completa(a)){ msg="Esa auditoría aún está en captura. Complétala (pasos 1 a 5) para generar su PDF."; return renderHist(); }
      return crearPDF([a],`Folio ${a.folio} · ${a.proveedor}`);
    }
    if(b.dataset.rm){if(confirm("¿Eliminar esta auditoría? No se puede deshacer.")){await store.remove(b.dataset.rm);}return renderHist();}
    if(b.id==="pdfDia"){
      const d=$("#dia").value;
      if(!d){ msg="Elige una fecha para el reporte."; return renderHist(); }
      /* Se relee de Firestore en lugar de confiar en window._list: si la lista
         está desactualizada (o vacía tras recargar la página), el botón parecía
         no funcionar. Y si falla la lectura, se informa la causa real. */
      let todos;
      try{ todos = await store.all(); }
      catch(err){ msg="No se pudo leer el historial: "+err.message; return renderHist(); }
      const l = todos.filter(a=>a.fecha===d && completa(a));
      if(!l.length){
        const enFecha = todos.filter(a=>a.fecha===d).length;
        msg = enFecha
          ? `Hay ${enFecha} auditoría(s) del ${d} pero ninguna está completa (pasos 1 a 5). Termínalas para incluirlas en el reporte.`
          : `No hay auditorías con fecha ${d}.`;
        return renderHist();
      }
      return crearPDF(l,`Reporte del día ${d}`);
    }
  }catch(err){ msg="No se pudo completar la acción: "+err.message; vista==="hist"?renderHist():render(); }
});

/* Al abandonar la página (cambiar de pestaña o cerrarla) se fuerza el guardado
   pendiente. `visibilitychange` cubre cambiar de app/pestaña en móvil, que es de
   donde vienen la mayoría de los "cierres sin querer". En el respaldo local se
   escribe de forma SÍNCRONA (nunca se pierde); en Firestore se dispara la escritura
   sin esperarla, que es lo mejor que permite el navegador al cerrar. */
function guardarAlSalir(){
  if(vista !== "nueva") return;
  respaldoLocal();
  if(autoguardadoTimer) { clearTimeout(autoguardadoTimer); autoguardadoTimer = null; }
  if(hayAvance(A) && huella(A) !== A.hist && (guardable(A) || guardableBorrador(A)) && (!cloud || usuario)){
    /* Se lanza sin await: en `pagehide` no hay tiempo de esperar la respuesta. */
    try{ guardar(); }catch(err){}
  }
}
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState === "hidden") guardarAlSalir(); });
window.addEventListener("pagehide", guardarAlSalir);
/* Respaldo extra en escritorio cuando se cierra la ventana: NO se usa preventDefault
   (no se quiere bloquear el cierre), solo se aprovecha para guardar el respaldo local. */
window.addEventListener("beforeunload", ()=>{ if(vista === "nueva") respaldoLocal(); });

/* ===== Extracción de partidas desde la factura (XML CFDI o PDF) =====
   IMPORTANTE: el archivo nunca se sube ni se guarda. Se lee en memoria con la
   File API del navegador, se extraen número de parte y cantidad, y el objeto
   File se descarta. A Firestore solo viajan las partidas confirmadas. */

/* Normaliza una cantidad y la devuelve como TEXTO.
   Devuelve string porque las reglas de Firestore exigen que fact/recib/real
   sean siempre texto (firestore.rules: `p.fact is string`). Si aquí saliera un
   número, el documento entero sería rechazado con permission-denied. */
function aNumero(v){
  if(v==null) return null;
  let t=String(v).trim().replace(/[^\d.,-]/g,"");
  if(!t) return null;
  const uc=t.lastIndexOf(","), up=t.lastIndexOf(".");
  if(uc>-1 && up>-1){
    /* El último separador es el decimal; el otro es de miles. */
    if(uc>up) t=t.replace(/\./g,"").replace(",",".");
    else t=t.replace(/,/g,"");
  }else if(uc>-1){
    /* Con coma: "1,50" es decimal en es-MX y "1,000" es mil. Se decide por el
       número de decimales: tres dígitos exactos = separador de miles. */
    t = (t.length-uc-1===3 && /^\d{1,3}(,\d{3})+$/.test(t)) ? t.replace(/,/g,"") : t.replace(",",".");
  }else if(up>-1){
    /* Solo puntos. En una factura mexicana el punto es el DECIMAL: el CFDI
       escribe Cantidad="1.000" para una pieza y Cantidad="2.5" para dos y
       medio. Interpretarlo como miles multiplicaba por mil la cantidad
       (el renglón de 1 pieza se cargaba como 1000), así que se respeta el
       valor tal como viene: no hay conversión que aplicar. */
  }
  const n=Number(t);
  return isFinite(n) ? n : null;
}

/* Convierte a texto seguro (12 caracteres máximo) lo que devuelve aNumero(). */
const cantidadTexto = v=>{
  const n = typeof v === "number" ? v : aNumero(v);
  if(n == null || !isFinite(n) || n <= 0) return "";
  const s = String(n);
  return s.length <= 12 ? s : String(Math.trunc(n)).slice(0, 12);
};
const limpia = s=>String(s??"").replace(/\s+/g," ").trim();
/* Topes de longitud que impone firestore.rules a cada partida. */
const TOPE_DESC = 300, TOPE_CODIGO = 60;

/* --- XML CFDI 3.3 / 4.0 --- */
function extraerXML(texto){
  const doc = new DOMParser().parseFromString(texto,"application/xml");
  if(doc.querySelector("parsererror")) throw new Error("El XML está dañado o no es un CFDI válido.");
  /* Los conceptos del CFDI traen NoIdentificacion (número de parte) y Cantidad. */
  let nodos = [...doc.getElementsByTagName("cfdi:Concepto")].concat([...doc.getElementsByTagName("Concepto")]);
  nodos = nodos.filter((n,i,a)=>a.indexOf(n)===i);
  /* Si el XML no es CFDI, se aceptan otros nombres de atributo. */
  if(!nodos.length) nodos = [...doc.querySelectorAll("[NoIdentificacion],[Codigo],[SKU],[CodigoArticulo],[ClaveProdServ]")];
  if(!nodos.length) throw new Error("No se encontraron conceptos en el XML. ¿Es una factura CFDI?");
  const crudo = nodos.map(n=>{
    const g=k=>n.getAttribute(k) || n.getAttribute(k.toLowerCase()) || "";
    /* Se devuelven los CINCO campos que exige partidaValida() de firestore.rules.
       Antes faltaban recib/real (y sobraba sicar): la partida quedaba incompleta y
       las reglas rechazaban el documento ENTERO con permission-denied si por
       cualquier ruta no pasaba por aplicarExtraccion() (que era quien los agregaba
       después). */
    return {
      /* Los topes replican `p.codigo.size() <= 60` y `p.desc.size() <= 300`
         de partidaValida(): una descripción larga del CFDI hacía fallar el
         guardado completo con permission-denied. */
      /* ClaveProdServ va AL FINAL como respaldo: en el CFDI es obligatoria,
         mientras que NoIdentificacion (el número de parte) es OPCIONAL. Sin este
         respaldo, un comprobante que solo trae ClaveProdServ dejaba `codigo`
         vacío y partidaValida() lo rechazaba (exige `p.codigo.size() > 0`). */
      codigo: limpia(g("NoIdentificacion") || g("Codigo") || g("SKU") || g("CodigoArticulo") || g("ClaveProdServ")).slice(0, TOPE_CODIGO),
      desc:   limpia(g("Descripcion") || n.textContent).slice(0, TOPE_DESC),
      /* Se entrega TEXTO: las reglas exigen `p.fact is string`. */
      fact:   cantidadTexto(g("Cantidad")),
      /* Lo facturado llega con la cantidad; lo recibido se captura en el Paso 3. */
      recib:  "",
      real:   "",
      /* El conteo por división (PV/BR) se captura en el Paso 4, no viene del CFDI. */
      realPV: "",
      realBR: ""
    };
  }).filter(p=>p.codigo || p.desc);
  /* Aviso: una partida SIN código no se puede guardar. partidaValida() exige
     `p.codigo.size() > 0`, así que ese documento daría permission-denied. Se
     informa con el conteo y el nombre del atributo alterno (ClaveProdServ, que
     es obligatorio en el CFDI) para que la causa quede explícita. */
  const sinCodigo = crudo.filter(p=>!p.codigo).length;
  const aviso = sinCodigo
    ? `Atención: ${sinCodigo} de ${crudo.length} partida(s) no traen código de artículo. ` +
      `Captúralo a mano (sugerencia: usa la clave de producto del SAT).`
    : "";
  return {partidas:crudo, cabecera:leerCabeceraCFDI(doc), fuente:"XML CFDI", aviso};
}

/* Toma folio, proveedor y fecha del comprobante, para no teclearlos tampoco.
   Los recortes replican los topes de contenidoValido() (folio 60, proveedor 120):
   una razón social larga hacía que el guardado fallara con permission-denied. */
function leerCabeceraCFDI(doc){
  const g=(tag,attr)=>{const n=doc.getElementsByTagName(tag)[0];return n?(n.getAttribute(attr)||""):"";};
  const emisor = doc.getElementsByTagName("cfdi:Emisor")[0] || doc.getElementsByTagName("Emisor")[0];
  /* El folio del CFDI es el identificador de la factura. El atributo estándar es
     Folio, pero hay comprobantes que solo traen Serie (o nada en Folio y el dato
     dentro del texto). Se intentan, en orden: Folio; Serie + Folio; Folie (error
     frecuente de captura en emisores); y por último el Folio del Timbre Fiscal
     Digital, que el SAT asigna y es único. Se conserva el UUID solo si no hubo
     ninguna otra opción, porque es largo pero identifica la factura sin dudas. */
  const folioSucio = limpia(g("cfdi:Comprobante","Folio"));
  const serie      = limpia(g("cfdi:Comprobante","Serie"));
  let folio = folioSucio, origenFolio = folioSucio ? "Comprobante/Folio" : "";
  if(!folio && serie){ folio = `${serie} ${folioSucio}`.trim(); origenFolio = "Serie + Folio"; }
  if(!folio){
    const alterno = limpia(g("cfdi:Comprobante","Folie"));
    if(alterno){ folio = alterno; origenFolio = "Comprobante/Folie (atributo no estándar)"; }
  }
  if(!folio){
    const uuid = limpia(g("cfdi:TimbreFiscalDigital","UUID") || g("TimbreFiscalDigital","UUID"));
    if(uuid){ folio = uuid; origenFolio = "UUID del timbre fiscal"; }
  }
  if(!folio && serie){ folio = serie; origenFolio = "Serie"; }
  return {
    /* El recorte replica el tope de contenidoValido() (folio 60): una cadena más
       larga hacía que el guardado fallara con permission-denied. */
    folio: folio.slice(0, 60),
    /* Se informa de dónde salió el folio: si vino del UUID conviene que el
       usuario lo sepa, porque no coincide con el número impreso en el papel. */
    folioOrigen: folio ? origenFolio : "",
    fecha:  limpia(g("cfdi:Comprobante","Fecha").slice(0,10)),
    proveedor: limpia(emisor ? emisor.getAttribute("Nombre") : "").slice(0, 120)
  };
}

/* --- PDF: se lee el texto de todas las páginas y se buscan renglones --- */
async function extraerPDF(archivo){
  const pdfjs = window.pdfjsLib;
  if(!pdfjs) throw new Error("No se pudo cargar el lector de PDF. Revisa tu conexión y recarga la página.");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const datos = await archivo.arrayBuffer();
  const doc = await pdfjs.getDocument({data:datos}).promise;
  const lineas = [];
  for(let n=1;n<=doc.numPages;n++){
    const pag = await doc.getPage(n);
    const cont = await pag.getTextContent();
    /* pdf.js entrega fragmentos sueltos: se agrupan por coordenada Y. */
    const porY = new Map();
    cont.items.forEach(it=>{
      const y = Math.round(it.transform[5]);
      if(!porY.has(y)) porY.set(y,[]);
      porY.get(y).push({x:it.transform[4], t:it.str});
    });
    [...porY.entries()].sort((a,b)=>b[0]-a[0]).forEach(([,frs])=>{
      const txt = frs.sort((a,b)=>a.x-b.x).map(f=>f.t).join(" ").replace(/\s+/g," ").trim();
      if(txt) lineas.push(txt);
    });
  }
  return lineas;
}

/* Interpreta cada renglón del PDF: código al inicio y cantidad al final.
   Es heurística porque el PDF no tiene estructura; el usuario revisa y corrige. */
function partidasDesdeLineas(lineas){
  const out=[];
  const basura = /^(subtotal|total|importe|iva|descuento|folio|fecha|rfc|factura|cliente|direcci|p[áa]gina|cantidad|precio|unidad|clave|no\.?\s*identif|descripci)/i;
  lineas.forEach(l=>{
    if(basura.test(l)) return;
    /* Patrón: código ... cantidad (la cantidad suele cerrar el renglón). */
    const m = l.match(/^([A-Za-z0-9][A-Za-z0-9._\-/]{2,29})\s+(.{3,80}?)\s+(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:pz|pza|pieza|piezas|kg|m|caja|paq|und)?\.?$/i);
    if(!m) return;
    const cant = cantidadTexto(m[3]);
    if(cant === "" ) return;
    const codigo = limpia(m[1]), desc = limpia(m[2]);
    /* Descarta renglones que en realidad son totales o claves fiscales. */
    if(!codigo || /^\d{6,}$/.test(codigo)) return;
    /* Se entregan los SEIS campos del esquema (ver partidaValida() en
       firestore.rules): los conteos por división quedan vacíos, para que la
       partida esté completa aunque no pase por aplicarExtraccion(). */
    out.push({
      codigo: codigo.slice(0, TOPE_CODIGO),
      desc:   desc.slice(0, TOPE_DESC),
      fact:   cant,
      recib:  "",
      real:   "",
      realPV: "",
      realBR: ""
    });
  });
  return out;
}

/* Orquesta la lectura: decide por extensión y tipo real del archivo. */
async function leerFactura(archivo){
  const nombre = (archivo.name||"").toLowerCase();
  const esPdf = nombre.endsWith(".pdf") || archivo.type==="application/pdf";
  if(esPdf){
    const lineas = await extraerPDF(archivo);
    return {partidas:partidasDesdeLineas(lineas), cabecera:{}, fuente:"PDF", lineas};
  }
  return extraerXML(await archivo.text());
}


/* Refleja en los campos del Paso 1 lo que se tomó de la factura.
   Se hace por DOM porque render() aún no ha corrido: los inputs ya están en
   pantalla con los valores viejos y el usuario debe VER que se llenaron. */
function pintarCabecera(campos){
  (campos||[]).forEach(k=>{
    const el = document.querySelector(`[data-f="${k}"]`);
    if(el) el.value = A[k];
  });
}

/* ¿Ya hay otra auditoría guardada con ese folio? Se compara sin distinguir
   mayúsculas ni espacios, y se ignora la auditoría abierta (comparando ids). */
async function yaExisteFolio(folio){
  const f = String(folio||"").trim().toLowerCase();
  if(!f) return null;
  /* window._list puede estar vacía si el usuario nunca abrió el historial: en
     ese caso se consulta a Firestore. Si la lectura falla (red bloqueada), se
     sigue sin avisar en lugar de impedir la captura. */
  let lista = window._list;
  if(!Array.isArray(lista) || !lista.length){
    try{ lista = await store.all(); }catch(err){ return null; }
  }
  return (lista||[]).find(x=>x && x.id !== A.id
    && String(x.folio||"").trim().toLowerCase() === f) || null;
}

/* Avisa si el folio de la factura ya fue capturado. Un folio es la identidad de
   la factura: capturarlo dos veces duplica el conteo de ajuste de inventario.
   Es un AVISO, no un bloqueo: una factura puede recibirse en dos parcialidades
   legítimas y el criterio final es del encargado. */
async function revisarFolioDuplicado(){
  const caja = document.getElementById("facturaMsg");
  if(!caja) return;
  if(!String(A.folio||"").trim()) return;
  const previo = await yaExisteFolio(A.folio);
  if(!previo) return;
  caja.insertAdjacentHTML("afterbegin",
    `<div class="msg msg-bad">
      <strong>Atención: el folio ${esc(A.folio)} ya está capturado</strong>
      (${esc(previo.fecha)} · ${esc(previo.proveedor||"sin proveedor")}${completa(previo)?"":" · en captura"}).
      Si estás capturando la misma factura, ábrela desde el historial en lugar de duplicarla:
      el conteo de ajuste de inventario se contaría dos veces.
    </div>`);
}

/* Pinta la vista previa: el usuario decide qué se queda antes de guardar nada. */
let facturaPendiente = null;
function pintarExtraccion(res, nombreArchivo){
  const caja = document.getElementById("facturaMsg");
  if(!caja) return;
  facturaPendiente = res;
  const p = res.partidas;
  if(!p.length){
    const extra = res.lineas
      ? `<details class="det-pdf"><summary>Ver el texto que se leyó del PDF (${res.lineas.length} líneas)</summary>
         <pre class="pre-pdf">${esc(res.lineas.slice(0,80).join("\n"))}</pre></details>`
      : "";
    caja.innerHTML = `<div class="msg">No se detectaron partidas en <strong>${esc(nombreArchivo)}</strong>.
      Captura las partidas a mano.${extra}</div>`;
    return;
  }
  caja.innerHTML = `<div class="card mt-lg v-ok">
    <p class="hint mb-s"><strong>${p.length} partidas detectadas</strong> en ${esc(res.fuente)}.
    Revisa y corrige lo que haga falta; solo se guardará lo que confirmes.</p>
    ${res.aviso ? `<div class="msg mb-s">${esc(res.aviso)}</div>` : ""}
    <div class="tw"><table><caption class="sr">Partidas detectadas en el archivo cargado</caption><tr><th scope="col">#</th><th scope="col">Código (no. de parte)</th><th scope="col">Descripción</th><th scope="col" class="n">Cantidad</th><th scope="col">Usar</th></tr>
    ${p.map((x,i)=>`<tr>
      <td>${i+1}</td>
      <td><input data-x="codigo" data-j="${i}" aria-label="Código de la partida detectada ${i+1}" value="${esc(x.codigo)}"></td>
      <td><input data-x="desc" data-j="${i}" aria-label="Descripción de la partida detectada ${i+1}" value="${esc(x.desc)}"></td>
      <td class="n"><input type="number" min="0" step="1" data-x="fact" data-j="${i}" aria-label="Cantidad de la partida detectada ${i+1}" value="${esc(x.fact)}"></td>
      <td><input type="checkbox" data-x="usar" data-j="${i}" checked aria-label="Cargar la partida detectada ${i+1}" class="cb-auto"></td>
    </tr>`).join("")}
    </table></div>
    <div class="bar"><button class="btn" id="aplicarFact">Cargar ${p.length} partidas</button>
    <button class="btn sec" id="cancelarFact">Cancelar</button></div>
    <p class="hint mt-s">Al cargar, el archivo se descarta de la memoria. No se guarda ninguna copia.</p>
  </div>`;
}

/* Vuelca lo confirmado en las partidas de la auditoría, sin tocar el archivo. */
function aplicarExtraccion(){
  if(!facturaPendiente) return 0;
  const nuevas = facturaPendiente.partidas.map((x,i)=>({x,i}))
    .filter(({i})=>{
      const c = document.querySelector(`[data-x="usar"][data-j="${i}"]`);
      return !c || c.checked;
    })
    .map(({x,i})=>{
      const val=(k,def)=>{const el=document.querySelector(`[data-x="${k}"][data-j="${i}"]`);return el?el.value:def;};
      /* cantidadTexto() garantiza TEXTO y el máximo de 12 caracteres que
         exigen las reglas de Firestore. Antes se usaba String(aNumero(...)||""),
         que convertía "0" en "" y dejaba pasar notaciones largas. */
      /* Los topes replican el tamaño máximo que aceptan las reglas para codigo
         (60) y desc (300): sin ellos, una descripción larga del CFDI hacía que
         Firestore rechazara el documento completo con permission-denied. */
      return {
        codigo: limpia(val("codigo",x.codigo)).slice(0, TOPE_CODIGO),
        desc:   limpia(val("desc",x.desc)).slice(0, TOPE_DESC),
        fact:   cantidadTexto(val("fact",x.fact))
      };
    })
    /* El filtro exige código porque partidaValida() rechaza `codigo` vacío
       (`p.codigo.size() > 0`). extraerXML() ya garantiza un código mediante el
       respaldo ClaveProdServ, así que solo se descarta si el usuario borró el
       campo a mano o la cantidad quedó en cero. */
    .filter(x=>x.codigo && aNumero(x.fact)>0)
    /* Se completan los campos de la partida aquí y también en extraerXML():
       las reglas exigen que existan TODOS, aunque vayan vacíos. Si faltara uno
       solo, Firestore rechaza el documento completo.
       Los conteos por división (PV/BR) nacen vacíos: se capturan en el Paso 4.
       `sicar` ya NO se agrega. */
    .map(x=>({codigo:x.codigo, desc:x.desc, fact:x.fact, recib:"", real:"", realPV:"", realBR:""}));
  if(!nuevas.length) return 0;
  /* Se respeta el tope de 20 partidas que exigen las reglas de Firestore. */
  const libres = MAX_PARTIDAS - A.partidas.length;
  const van = nuevas.slice(0, Math.max(0,libres));
  /* Si solo había la fila vacía inicial, se reemplaza en vez de sumar basura. */
  const soloVacia = A.partidas.length===1 && !A.partidas[0].codigo && !A.partidas[0].desc && A.partidas[0].fact==="";
  A.partidas = (soloVacia ? [] : A.partidas).concat(van);
  if(!A.partidas.length) A.partidas = [linea0()];
  return van.length;
}

/* ===== PDF ===== */
/* Verifica que las librerías del CDN estén disponibles antes de generar nada.
   Si el navegador bloqueó cdnjs (bloqueador de anuncios, red restringida,
   ERR_BLOCKED_BY_CLIENT), window.jspdf queda undefined y el botón "no hacía
   nada" con un error incomprensible (Cannot destructure property 'jsPDF'...).
   El PDF se genera en el navegador: no depende de Firestore ni de la sesión. */
function pdfListo(){
  if(!window.jspdf || typeof window.jspdf.jsPDF !== "function") return false;
  return true;
}
function avisoPdf(){
  return "No se pudieron cargar las librerías del PDF (jspdf desde cdnjs). " +
    "Revisa que el navegador o la red no estén bloqueando cdnjs.cloudflare.com, " +
    "o genera el reporte desde otra red. El resto de la aplicación sigue funcionando.";
}

function crearPDF(list,titulo){
  if(!pdfListo()) throw new Error(avisoPdf());
  /* Solo se reportan auditorías con captura completa: un documento a medias
     produciría un PDF con cifras engañosas. */
  const utiles = (list||[]).filter(a=>a && completa(a));
  if(!utiles.length) throw new Error("No hay auditorías completas que reportar. Termina la captura (pasos 1 a 5) antes de generar el PDF.");
  list = utiles;
  const {jsPDF}=window.jspdf, d=new jsPDF({unit:"pt",format:"letter"});
  const W=d.internal.pageSize.getWidth(), H=d.internal.pageSize.getHeight(), M=40;
  d.setFillColor(27,36,48); d.rect(0,0,W,70,"F");
  d.setTextColor(255); d.setFont("helvetica","bold"); d.setFontSize(17);
  d.text("Reporte de hallazgos: microinventario de recepción",M,32);
  d.setFont("helvetica","normal"); d.setFontSize(10);
  d.text(titulo,M,50); d.text("Emitido: "+new Date().toLocaleString("es-MX"),W-M,50,{align:"right"});
  d.setTextColor(27,36,48);
  const r=resumen(list); let y=96;
  d.setFont("helvetica","bold"); d.setFontSize(12); d.text("Resumen general",M,y); y+=8;
  d.autoTable({startY:y,margin:{left:M,right:M},theme:"grid",styles:{fontSize:9,cellPadding:5},headStyles:{fillColor:[31,92,122]},
    head:[["Auditorías","Partidas","Con hallazgo","Faltantes en recepción","Sobrantes en recepción"]],
    body:[[r.aud,r.part,r.hall,r.falt,r.sobr]]});
  y=d.lastAutoTable.finalY+24;
  /* Conteo total para ajuste de inventario: solo se marca utilizable si
     Dif. recep. no tiene diferencias en ninguna partida del reporte. */
  d.setFont("helvetica","bold"); d.setFontSize(12); d.text("Conteo total para ajuste de inventario",M,y); y+=8;
  d.autoTable({startY:y,margin:{left:M,right:M},theme:"grid",styles:{fontSize:9,cellPadding:5},
    headStyles:{fillColor:r.recepcionConforme?[42,122,75]:[179,57,27]},
    head:[["Total facturado","Total recibido","Total real en anaquel","Recibido + Real","¿Apto para ajuste?"]],
    body:[[r.fact,r.recib,r.real,r.totalAjuste,r.recepcionConforme?"Sí (Dif. recep. = 0)":"No (Dif. recep. != 0)"]],
    columnStyles:{0:{halign:"right"},1:{halign:"right"},2:{halign:"right"},3:{halign:"right"}}});
  y=d.lastAutoTable.finalY+10;
  d.setFont("helvetica","italic"); d.setFontSize(8);
  /* La sugerencia de ajuste ya NO cita la diferencia contra SICAR: ese paso se
     eliminó y el conteo total (recibido + real) es la única cifra del reporte. */
  if(r.recepcionConforme){
    d.text(`Ajuste sugerido: fijar la existencia en ${r.totalAjuste} piezas (real + recibido).`,M,y+8);
  }else{
    d.text(`No usar para ajuste: hay diferencias de recepción (faltantes: ${r.falt}, sobrantes: ${r.sobr}). Aclare la recepción primero.`,M,y+8);
  }
  y+=30;
  list.forEach((a)=>{
    if(y>H-200){d.addPage();y=50;}
    d.setFont("helvetica","bold"); d.setFontSize(11);
    d.text(`Folio ${a.folio} | ${a.proveedor} | Línea ${a.linea} | ${a.fecha}`,M,y);
    d.setFont("helvetica","normal"); d.setFontSize(9);
    d.text(`Recibió: ${a.encargado}    Verificó: ${a.verificador}`,M,y+13);
    d.autoTable({startY:y+20,margin:{left:M,right:M},theme:"grid",styles:{fontSize:8,cellPadding:4},headStyles:{fillColor:[31,92,122]},
      head:[["Código","Descripción","Fact.","Recib.","Dif. recep.","Real PV","Real BR","Real total","Resultado"]],
      body:a.partidas.map(p=>[p.codigo,p.desc,p.fact,p.recib,fmt(dR(p)),p.realPV===""?"—":p.realPV,p.realBR===""?"—":p.realBR,p.real,resultado(p)]),
      columnStyles:{2:{halign:"right"},3:{halign:"right"},4:{halign:"right"},5:{halign:"right"},6:{halign:"right"},7:{halign:"right"}},
      didParseCell:h=>{ if(h.section==="body"&&h.row.raw[8]!=="Conforme"){h.cell.styles.fillColor=[251,234,229];} }});
    y=d.lastAutoTable.finalY+10;
    /* Conteo por folio, con la misma regla: usar la suma solo si Dif. recep. = 0.
       Se divide en dos líneas porque el aviso supera el ancho útil de la página. */
    const ra=resumen([a]);
    d.setFont("helvetica","bold"); d.setFontSize(9);
    if(ra.recepcionConforme){
      d.setTextColor(42,122,75);
      d.text(`Conteo total para ajuste: recibido ${ra.recib} + real ${ra.real} = ${ra.totalAjuste} piezas.`,M,y);
      d.setFont("helvetica","normal");
      d.text("Dif. recep. sin diferencias: la suma es confiable para ajustar el inventario.",M,y+11);
    }else{
      d.setTextColor(179,57,27);
      d.text(`Conteo total informativo: recibido ${ra.recib} + real ${ra.real} = ${ra.totalAjuste} piezas.`,M,y);
      d.setFont("helvetica","normal");
      d.text(`NO usar para ajuste: Dif. recep. con diferencias (faltantes ${ra.falt}, sobrantes ${ra.sobr}). Aclare la recepción.`,M,y+11);
    }
    d.setTextColor(27,36,48);
    y+=40;
    if(y>H-70){d.addPage();y=90;}
    d.setDrawColor(27,36,48); d.setFontSize(8);
    [[a.encargado,"Encargado de recepción"],[a.verificador,"Verificador"],["","Gerencia"]].forEach((s,i)=>{
      const x=M+i*175; d.line(x,y,x+150,y); d.text(s[0]||" ",x,y+11); d.text(s[1],x,y+22);
    });
    y+=52;
  });
  const n=d.getNumberOfPages();
  for(let i=1;i<=n;i++){d.setPage(i);d.setFontSize(8);d.setTextColor(93,107,120);d.text(`Página ${i} de ${n}`,W-M,H-20,{align:"right"});}
  d.save(`hallazgos_${list.length===1?"folio_"+list[0].folio:"dia"}_${list[0].fecha}.pdf`);
}

/* El arranque lo dispara onAuthStateChanged: con sesión pinta la app, sin sesión pinta el login. */
if(!cloud) render();
