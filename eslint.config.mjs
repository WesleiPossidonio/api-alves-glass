// .eslintrc.cjs
import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
    plugins: ["prettier"],
    extends: [
      js.configs.recommended, // Regras recomendadas do ESLint
      "prettier",             // Desativa regras do ESLint que conflitam com Prettier
    ],
    rules: {
      camelcase: "off",
      "prettier/prettier": "error", // Mostra erro quando Prettier não for seguido
    },
  },
]);
