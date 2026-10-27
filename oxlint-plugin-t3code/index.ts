import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import oneTestApiImport from "./rules/one-test-api-import.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-test-in-loop": noTestInLoop,
    "no-unscoped-has": noUnscopedHas,
    "one-test-api-import": oneTestApiImport,
    "require-suppression-reason": requireSuppressionReason,
  },
});
