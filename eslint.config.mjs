import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
