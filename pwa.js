/* ===========================================================================
 * pwa.js — Instalación de la PWA y comportamiento "nativo".
 * Script clásico (no módulo), aislado de la lógica de negocio de index.html.
 *
 * - Registra ./sw.js solo en contexto seguro y si hay soporte.
 * - Muestra "Instalar app" (Android/Chrome) cuando el navegador lo permite
 *   (beforeinstallprompt) y lo OCULTA para siempre en app instalada.
 * - En iOS/Safari (sin beforeinstallprompt) muestra un aviso con instrucciones.
 * - Aviso de "nueva versión" (skipWaiting + recarga controlada).
 * - Aviso de "sin conexión".
 * ======================================================================== */
(function () {
  "use strict";

  /* ---------- almacenamiento con try/catch ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }

  var LS_INSTALADA = "pwa:instalada";       // respaldo (NO es la fuente de verdad)
  var SS_IOS_DESCARTADO = "pwa:iosDescartado";

  /* ---------- referencias del DOM ---------- */
  var btnInstall = document.getElementById("pwaInstall");
  var banner = document.getElementById("pwaBanner");
  var bannerBtn = document.getElementById("pwaUpdate");
  var offline = document.getElementById("pwaOffline");
  var iosDlg = document.getElementById("pwaIosDlg");
  var iosCerrar = document.getElementById("pwaIosCerrar");

  /* =======================================================================
   * 1) Registro del service worker
   * ==================================================================== */
  var swReg = null;
  var CONTEXTO_SEGURO =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

  function registrarSW() {
    if (!("serviceWorker" in navigator) || !CONTEXTO_SEGURO) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).then(function (reg) {
        swReg = reg;
        if (reg.waiting) mostrarBanner();
        reg.addEventListener("updatefound", function () {
          var nuevo = reg.installing;
          if (!nuevo) return;
          nuevo.addEventListener("statechange", function () {
            if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
              mostrarBanner();
            }
          });
        });
      }).catch(function () { /* sin SW la app sigue funcionando */ });

      var recargando = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (recargando) return;
        recargando = true;
        window.location.reload();
      });
    });
  }

  function mostrarBanner() { if (banner) banner.setAttribute("aria-hidden", "false"); }

  if (bannerBtn) {
    bannerBtn.addEventListener("click", function () {
      if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: "SKIP_WAITING" });
      if (banner) banner.setAttribute("aria-hidden", "true");
    });
  }

  /* =======================================================================
   * 2) Detección de "app instalada"
   * ==================================================================== */
  var MEDIA_MODOS = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];
  var appInstalada = false;

  function enModoApp() {
    if (window.matchMedia) {
      for (var i = 0; i < MEDIA_MODOS.length; i++) {
        try { if (window.matchMedia("(display-mode: " + MEDIA_MODOS[i] + ")").matches) return true; } catch (_) {}
      }
    }
    if (navigator.standalone === true) return true;                 // iOS Safari
    if ((document.referrer || "").indexOf("android-app://") === 0) return true;
    return false;
  }

  function marcarInstalada() {
    appInstalada = true;
    ocultarBoton();
    if (iosDlg && iosDlg.open && typeof iosDlg.close === "function") iosDlg.close();
  }

  function evaluarInstalacion() {
    if (enModoApp()) { marcarInstalada(); return true; }
    if (lsGet(LS_INSTALADA) === "1") { appInstalada = true; ocultarBoton(); return true; }
    return false;
  }

  if (window.matchMedia) {
    MEDIA_MODOS.forEach(function (modo) {
      try {
        var mq = window.matchMedia("(display-mode: " + modo + ")");
        var handler = function (e) { if (e.matches) marcarInstalada(); };
        if (mq.addEventListener) mq.addEventListener("change", handler);
        else if (mq.addListener) mq.addListener(handler);
      } catch (_) {}
    });
  }

  // a) Evento oficial de instalación completada.
  window.addEventListener("appinstalled", function () { marcarInstalada(); });

  // e) getInstalledRelatedApps() (opcional, con detección de características).
  /* =======================================================================
   * 3) Botón de instalación (Android / navegadores Chromium)
   * ==================================================================== */
  var deferredPrompt = null;

  function mostrarBoton() { if (btnInstall) btnInstall.setAttribute("aria-hidden", "false"); }
  function ocultarBoton() { if (btnInstall) btnInstall.setAttribute("aria-hidden", "true"); }

  window.addEventListener("beforeinstallprompt", function (e) {
    // El evento es la FUENTE DE VERDAD: si vuelve a dispararse, el usuario
    // puede instalar; borramos cualquier indicador viejo que lo bloqueara.
    lsDel(LS_INSTALADA);
    appInstalada = false;

    e.preventDefault();
    deferredPrompt = e;

    if (!enModoApp()) mostrarBoton();
  });

  if (btnInstall) {
    btnInstall.addEventListener("click", function () {
      if (!deferredPrompt) return;          // en iOS lo maneja el flujo del diálogo
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () {
        deferredPrompt = null;              // el evento solo puede usarse una vez
        ocultarBoton();
      }).catch(function () {
        deferredPrompt = null;
        ocultarBoton();
      });
    });
  }

  /* =======================================================================
   * 4) iOS / Safari (sin beforeinstallprompt)
   * ==================================================================== */
  function esIOS() {
    return (
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) // iPadOS
    );
  }

  function esInstaladaLocal() { return lsGet(LS_INSTALADA) === "1"; }

  function ofrecerIOS() {
    if (!esIOS() || enModoApp() || esInstaladaLocal()) return;
    if (ssGet(SS_IOS_DESCARTADO) === "1") return;
    if (btnInstall) {
      // Reutilizamos el botón del header para abrir el diálogo en iOS.
      btnInstall.setAttribute("aria-label", "Cómo instalar la app");
      btnInstall.setAttribute("aria-hidden", "false");
    }
  }

  if (iosCerrar) {
    iosCerrar.addEventListener("click", function () {
      ssSet(SS_IOS_DESCARTADO, "1");
      if (iosDlg && typeof iosDlg.close === "function") iosDlg.close();
    });
  }

  if (btnInstall && iosDlg) {
    btnInstall.addEventListener("click", function () {
      if (deferredPrompt) return;   // ya lo maneja el flujo de instalación de Chromium
      if (!esIOS()) return;
      if (typeof iosDlg.showModal === "function") {
        iosDlg.showModal();
        if (iosCerrar) iosCerrar.focus();
      } else {
        iosDlg.setAttribute("open", "");
      }
    });
    // Cierre con Escape (nativo en <dialog>; se refuerza por compatibilidad).
    iosDlg.addEventListener("cancel", function (e) {
      e.preventDefault();
      ssSet(SS_IOS_DESCARTADO, "1");
      iosDlg.close();
    });
  }

  /* =======================================================================
   * 5) Estado de conexión
   * ==================================================================== */
  function pintarConexion() {
    if (!offline) return;
    offline.setAttribute("aria-hidden", navigator.onLine ? "true" : "false");
  }
  window.addEventListener("online", pintarConexion);
  window.addEventListener("offline", pintarConexion);

  /* =======================================================================
   * 6) Arranque
   * ==================================================================== */
  registrarSW();
  evaluarInstalacion();
  ofrecerIOS();
  pintarConexion();
})();

