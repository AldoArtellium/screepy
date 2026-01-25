module.exports = {
    env: { browser: true, es6: true, node: true },
    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
        "plugin:import/errors",
        "plugin:import/warnings",
        "plugin:import/typescript",
        "prettier"
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: { project: "tsconfig.json", sourceType: "module" },
    plugins: ["@typescript-eslint", "import"],
    rules: {
        // Migrated from tslint.json
        "@typescript-eslint/explicit-member-accessibility": ["error", { accessibility: "no-public" }],
        "@typescript-eslint/no-empty-interface": "off",
        "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        "@typescript-eslint/ban-types": "off",
        "no-empty": "off",
        "no-console": "off",
        "max-len": ["warn", { code: 120, ignoreComments: true, ignoreStrings: true }],
        "indent": "off",
        "quotes": ["error", "double", { avoidEscape: true }],
        "prefer-const": ["error", { destructuring: "all" }],
        "import/no-unresolved": "off",
        "prefer-rest-params": "off",
        "@typescript-eslint/no-unnecessary-type-constraint": "off"
    },
    ignorePatterns: ["node_modules/", "dist/", "tsc-out/", "*.js", "src/deprecated/"]
};
