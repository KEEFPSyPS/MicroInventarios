// ESLint flat config — https://eslint.org/docs/latest/use/configure/configuration-files
// El proyecto es una PWA estática sin build: HTML/CSS/JS vanilla con módulos ES.
import js from "@eslint/js";
import globals from "globals";

export default [
  // 1) No lintear artefactos ni dependencias.
  {
    ignores: ["node_modules/**", "icons/**", "*.min.js", "firebase-config.js"]
  },

  // 2) Reglas base recomendadas por ESLint.
  js.configs.recommended,

  // 3) App en el navegador (app.js, busqueda.js, pwa.js, sw.js): módulos ES con APIs del DOM.
  {
    files: ["app.js", "busqueda.js", "pwa.js", "sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // Librerías cargadas por <script> desde CDN (globales en window).
        pdfjsLib: "readonly",
        jspdf: "readonly"
      }
    },
    rules: {
      // Lo que ya usa el código: no exigir variables no usadas por parámetros
      // intencionalmente ignorados, pero sí avisar de las de más.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "error",
      "no-var": "off",
      eqeqeq: "off",
      "no-empty": ["warn", { allowEmptyCatch: true }]
    }
  },

  // 4) Scripts de Node (test + generación de iconos + scripts/ de build).
  {
    files: ["verificar-pasos.cjs", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  },

  // Los .cjs son CommonJS (require): sobreescribe el sourceType.
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" }
  },

  // 5) Config del propio ESLint (eslint.config.js) corre en Node.
  {
    files: ["eslint.config.js"],
    languageOptions: { globals: { ...globals.node } }
  }
];
