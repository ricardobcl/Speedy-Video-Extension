import js from "@eslint/js"
import globals from "globals"

export default [
  {
    ignores: [
      "chrome/**",
      "safari/**",
      "node_modules/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions }
    }
  },
  {
    files: ["src/background.js"],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.webextensions }
    }
  }
]
