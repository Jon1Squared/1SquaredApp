import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Owner Decision 2 & Platform Architecture Standard §8 (Rule 4):
  // Only `core/src/tenancy/` may import `pg` or open a PostgreSQL connection.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mjs", "**/*.js"],
    ignores: ["core/src/tenancy/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Rule 4 / Owner Decision 2: Direct `pg` imports are forbidden outside `core/src/tenancy/**`. Use a `TenantScopedRepository` subclass instead.",
            },
            {
              name: "@/server/store",
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired. Use per-tenant PostgreSQL repositories in `core/src/tenancy/`.",
            },
          ],
          patterns: [
            {
              group: ["pg/*"],
              message:
                "Rule 4 / Owner Decision 2: Direct `pg` imports are forbidden outside `core/src/tenancy/**`.",
            },
            {
              group: ["**/server/store", "**/server/store.*"],
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired. Use per-tenant PostgreSQL repositories in `core/src/tenancy/`.",
            },
          ],
        },
      ],
    },
  },
  // S0-20 / ADR 0026 / ADR 0028:
  // `core/src/tenancy/**` may import `pg`, but must never import `@/server/store` or `@/seed/*`.
  {
    files: ["core/src/tenancy/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/store",
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired.",
            },
          ],
          patterns: [
            {
              group: ["**/server/store", "**/server/store.*"],
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired.",
            },
            {
              group: ["@/seed/*", "**/seed/*"],
              message:
                "S0-20 / ADR 0026: Seed builders (`src/seed/*`) must not be imported in `core/**`.",
            },
          ],
        },
      ],
    },
  },
  // S0-20 / ADR 0026 / ADR 0028:
  // Runtime code in `src/app/**`, `src/components/**`, `core/src/**` (outside tenancy), and `src/server/**`
  // (except the gated non-live demo reset and PostgreSQL seed-import helpers) must not import
  // `@/seed/*` or `@/server/store`.
  {
    files: [
      "src/app/**/*.ts",
      "src/app/**/*.tsx",
      "src/components/**/*.ts",
      "src/components/**/*.tsx",
      "core/src/**/*.ts",
      "src/server/**/*.ts",
    ],
    ignores: [
      "core/src/tenancy/**",
      "src/server/services.ts",
      "src/server/storePostgresImport.ts",
      "src/server/**/*.test.ts",
      "src/server/testSupport/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Rule 4 / Owner Decision 2: Direct `pg` imports are forbidden outside `core/src/tenancy/**`. Use a `TenantScopedRepository` subclass instead.",
            },
            {
              name: "@/server/store",
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired.",
            },
          ],
          patterns: [
            {
              group: ["pg/*"],
              message:
                "Rule 4 / Owner Decision 2: Direct `pg` imports are forbidden outside `core/src/tenancy/**`.",
            },
            {
              group: ["**/server/store", "**/server/store.*"],
              message:
                "S0-20 / ADR 0028: The transitional JSON runtime store (`src/server/store.ts`) is retired.",
            },
            {
              group: ["@/seed/*", "**/seed/*"],
              message:
                "S0-20 / ADR 0026: Seed builders (`src/seed/*`) may only be imported by explicit seeding scripts, tests, and the gated non-live demo reset helper.",
            },
          ],
        },
      ],
    },
  },
  // Technical debt (tracked under docs/decisions/0001-shared-repo-and-transitional-store.md; reviewed per docs/architecture-standard.md):
  // Legacy UI components predating this branch contain pre-existing React Compiler warnings;
  // keep those rules as 'error' across all new/updated components (including HomePagesAdminSection.tsx).
  {
    files: [
      "src/components/CreateTaskModal.tsx",
      "src/components/DataList.tsx",
      "src/components/EnquiryFormClient.tsx",
      "src/components/EnquiryPreviewDrawer.tsx",
      "src/components/FormControls.tsx",
      "src/components/MatterPartiesAdminSection.tsx",
      "src/components/SearchBox.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    "e2e/.auth/**",
  ]),
]);

export default eslintConfig;
