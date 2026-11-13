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
          ],
          patterns: [
            {
              group: ["pg/*"],
              message:
                "Rule 4 / Owner Decision 2: Direct `pg` imports are forbidden outside `core/src/tenancy/**`.",
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
