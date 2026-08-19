import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "server/dist/", "coverage/", "release/"],
  },
  {
    files: ["**/*.mjs"],
    linterOptions: {
      noInlineConfig: true,
    },
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-useless-escape": "off",
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_$|^startHttpServer$",
        },
      ],
    },
  },
  prettier,
];
