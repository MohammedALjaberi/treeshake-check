import { readFileSync } from "fs";
import { relative } from "path";
import type { TreeShakingIssue } from "../types/index.js";
import { stripLiteralsAndComments } from "../utils/strip-literals.js";

// CommonJS patterns that indicate CJS module
// Note: require pattern excludes template literals with ${...}
const CJS_PATTERNS = {
  require: /\brequire\s*\(\s*['"](?!\$\{)[^'"$]+['"]\s*\)/,
  moduleExports: /\bmodule\.exports\b/,
  exportsAssign: /\bexports\.[a-zA-Z_$][a-zA-Z0-9_$]*\s*=/,
  __dirname: /\b__dirname\b/,
  __filename: /\b__filename\b/,
};

// ESM patterns
const ESM_PATTERNS = {
  import:
    /\bimport\s+(?:{[^}]+}|[a-zA-Z_$][a-zA-Z0-9_$]*|\*)\s+from\s+['"][^'"]+['"]/,
  export: /\bexport\s+(?:default|const|let|var|function|class|{)/,
  dynamicImport: /\bimport\s*\(/,
};

// Libraries known to NOT be tree-shakeable (or their default/namespace import pulls everything)
const NON_TREESHAKEABLE_LIBRARIES: Record<
  string,
  { alternative: string; estimatedSize: number }
> = {
  lodash: { alternative: "lodash-es", estimatedSize: 72000 },
  moment: { alternative: "dayjs or date-fns", estimatedSize: 67000 },
  underscore: { alternative: "lodash-es or native methods", estimatedSize: 17000 },
  jquery: { alternative: "native DOM APIs", estimatedSize: 87000 },
};

// Libraries where namespace/full imports are problematic but named imports are fine
const LARGE_LIBRARIES_WITH_SUBPATHS: Record<
  string,
  { suggestion: string; estimatedSize: number }
> = {
  "@mui/material": { suggestion: "@mui/material/Button", estimatedSize: 300000 },
  "@mui/icons-material": { suggestion: "@mui/icons-material/SpecificIcon", estimatedSize: 500000 },
  "antd": { suggestion: "antd/es/button", estimatedSize: 200000 },
  "@ant-design/icons": { suggestion: "@ant-design/icons/SpecificIcon", estimatedSize: 100000 },
  "react-icons": { suggestion: "react-icons/fa/FaSpecificIcon", estimatedSize: 150000 },
  "@chakra-ui/react": { suggestion: "import only used components", estimatedSize: 100000 },
  "rxjs": { suggestion: "rxjs/operators", estimatedSize: 50000 },
  "@fortawesome/free-solid-svg-icons": { suggestion: "import specific icons only", estimatedSize: 80000 },
};

/**
 * Analyze files to detect CommonJS vs ESM module patterns
 */
export async function analyzeModuleTypes(
  files: string[],
  projectPath: string,
): Promise<TreeShakingIssue[]> {
  const issues: TreeShakingIssue[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const fileIssues = analyzeModuleType(content, file, projectPath);
      issues.push(...fileIssues);
    } catch {
      // Skip files that can't be read
    }
  }

  return issues;
}

function analyzeModuleType(
  content: string,
  filePath: string,
  projectPath: string,
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];
  const relPath = relative(projectPath, filePath);

  // Skip declaration files
  if (filePath.endsWith(".d.ts")) {
    return issues;
  }

  // Strip string literals and comments to avoid false positives from code examples
  const strippedContent = stripLiteralsAndComments(content);

  // Detect patterns on stripped content
  const hasCJS = Object.entries(CJS_PATTERNS).some(([_, pattern]) =>
    pattern.test(strippedContent),
  );
  const hasESM = Object.entries(ESM_PATTERNS).some(([_, pattern]) =>
    pattern.test(strippedContent),
  );

  // Mixed module system usage
  if (hasCJS && hasESM) {
    // Exclude template literals like require('${...}')
    const requireMatches = content.matchAll(
      /\brequire\s*\(\s*['"](?!\$\{)([^'"$]+)['"]\s*\)/g,
    );
    for (const match of requireMatches) {
      // Skip matches inside strings / comments
      if (match.index !== undefined && strippedContent[match.index] === " ") continue;
      const line = content.substring(0, match.index).split("\n").length;
      const moduleName = match[1];

      issues.push({
        type: "commonjs-module",
        severity: "high",
        file: relPath,
        line,
        pattern: `require('${moduleName}')`,
        description: `Mixed ESM/CJS: require() in an ESM file prevents optimal tree-shaking for '${moduleName}'.`,
        estimatedImpact: estimateCJSImpact(moduleName),
        suggestion: {
          title: "Convert to ESM import",
          description: "Replace require() with ESM import statement.",
          code: `import ${getImportSuggestion(moduleName)} from '${moduleName}'`,
        },
      });
    }
  }

  // Pure CJS file in an ESM project
  if (hasCJS && !hasESM) {
    // Check for module.exports
    const moduleExportsMatch = content.match(/\bmodule\.exports\s*=/);
    if (moduleExportsMatch) {
      const line = content
        .substring(0, moduleExportsMatch.index)
        .split("\n").length;

      issues.push({
        type: "commonjs-module",
        severity: "medium",
        file: relPath,
        line,
        pattern: "module.exports = ...",
        description:
          "CommonJS module.exports prevents tree-shaking. The entire module will be included when imported.",
        estimatedImpact: 2000,
        suggestion: {
          title: "Convert to ESM exports",
          description: "Replace module.exports with named exports.",
          code: `export { functionName }; // or export default value`,
        },
      });
    }
  }

  // Check for problematic CommonJS imports
  const problematicCJSImports = [
    {
      pattern: /require\s*\(\s*['"]lodash['"]\s*\)/,
      module: "lodash",
      alternative: "lodash-es",
    },
    {
      pattern: /require\s*\(\s*['"]moment['"]\s*\)/,
      module: "moment",
      alternative: "dayjs or date-fns",
    },
    {
      pattern: /require\s*\(\s*['"]underscore['"]\s*\)/,
      module: "underscore",
      alternative: "lodash-es",
    },
  ];

  for (const { pattern, module, alternative } of problematicCJSImports) {
    if (pattern.test(strippedContent)) {
      const match = content.match(pattern);
      const line = match
        ? content.substring(0, match.index).split("\n").length
        : 0;
      // Skip if the match is inside a string / comment
      if (match?.index !== undefined && strippedContent[match.index] === " ") continue;

      issues.push({
        type: "commonjs-module",
        severity: "critical",
        file: relPath,
        line,
        pattern: `require('${module}')`,
        description: `'${module}' is a CommonJS module that doesn't tree-shake. Consider using '${alternative}'.`,
        estimatedImpact: module === "lodash" ? 72000 : 50000,
        suggestion: {
          title: `Use ${alternative} instead`,
          description: `Replace ${module} with ${alternative} for proper tree-shaking.`,
          code: `import { specificFunction } from '${alternative}'`,
        },
      });
    }
  }

  // ── ESM import analysis ──────────────────────────────────────────────
  // Detect problematic ESM import patterns that hurt tree-shaking

  const esmIssues = analyzeESMImports(content, strippedContent, relPath);
  issues.push(...esmIssues);

  return issues;
}

/**
 * Analyze ESM import statements for tree-shaking problems
 */
function analyzeESMImports(
  content: string,
  strippedContent: string,
  relPath: string,
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  // Helper: check if a match at a given position is inside a string/comment
  // by verifying the stripped content still has the keyword at that position
  function isInCodeRegion(matchIndex: number | undefined): boolean {
    if (matchIndex === undefined) return true;
    // If the position in strippedContent is a space, the match was inside
    // a string literal or comment — skip it
    return strippedContent[matchIndex] !== " ";
  }

  // 1. Default import of non-tree-shakeable library: import X from 'lodash'
  //    (skip "import type" since that's a TS type-only import)
  const defaultImportRegex =
    /\bimport\s+(?!type\b)([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"]([^'"./][^'"]*)['"]/g;
  for (const match of content.matchAll(defaultImportRegex)) {
    if (!isInCodeRegion(match.index)) continue;

    const localName = match[1];
    const moduleName = match[2];
    const line = content.substring(0, match.index).split("\n").length;

    // Check against known non-tree-shakeable libraries
    for (const [lib, info] of Object.entries(NON_TREESHAKEABLE_LIBRARIES)) {
      if (moduleName === lib) {
        issues.push({
          type: "commonjs-module",
          severity: "critical",
          file: relPath,
          line,
          pattern: `import ${localName} from '${moduleName}'`,
          description: `Default import of '${moduleName}' pulls in the entire library (~${formatKB(info.estimatedSize)}). It is not tree-shakeable.`,
          estimatedImpact: info.estimatedSize,
          suggestion: {
            title: `Use ${info.alternative} instead`,
            description: `Replace with tree-shakeable alternative or use named imports from subpaths.`,
            code: `import { specificFunction } from '${info.alternative}'`,
          },
        });
      }
    }

    // Check against large libraries where default import is bad
    for (const [lib, info] of Object.entries(LARGE_LIBRARIES_WITH_SUBPATHS)) {
      if (moduleName === lib) {
        issues.push({
          type: "barrel-file",
          severity: "high",
          file: relPath,
          line,
          pattern: `import ${localName} from '${moduleName}'`,
          description: `Default import from '${moduleName}' may include the entire library (~${formatKB(info.estimatedSize)}). Use direct subpath imports instead.`,
          estimatedImpact: info.estimatedSize,
          suggestion: {
            title: "Use subpath imports",
            description: `Import directly from subpaths to enable tree-shaking.`,
            code: `import Component from '${info.suggestion}'`,
          },
        });
      }
    }
  }

  // 2. Namespace (star) import of external packages: import * as X from 'library'
  const namespaceImportRegex =
    /\bimport\s+\*\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"]([^'"./][^'"]*)['"]/g;
  for (const match of content.matchAll(namespaceImportRegex)) {
    if (!isInCodeRegion(match.index)) continue;

    const localName = match[1];
    const moduleName = match[2];
    const line = content.substring(0, match.index).split("\n").length;

    // Check non-tree-shakeable libraries
    for (const [lib, info] of Object.entries(NON_TREESHAKEABLE_LIBRARIES)) {
      if (moduleName === lib) {
        issues.push({
          type: "commonjs-module",
          severity: "critical",
          file: relPath,
          line,
          pattern: `import * as ${localName} from '${moduleName}'`,
          description: `Namespace import of '${moduleName}' pulls in the entire library (~${formatKB(info.estimatedSize)}). It is not tree-shakeable.`,
          estimatedImpact: info.estimatedSize,
          suggestion: {
            title: `Use ${info.alternative} with named imports`,
            description: `Replace with tree-shakeable alternative and use named imports.`,
            code: `import { specificFunction } from '${info.alternative}'`,
          },
        });
        break;
      }
    }

    // Check large libraries with subpaths
    for (const [lib, info] of Object.entries(LARGE_LIBRARIES_WITH_SUBPATHS)) {
      if (moduleName === lib) {
        issues.push({
          type: "barrel-file",
          severity: "high",
          file: relPath,
          line,
          pattern: `import * as ${localName} from '${moduleName}'`,
          description: `Namespace import from '${moduleName}' forces the entire library (~${formatKB(info.estimatedSize)}) into the bundle. Use direct subpath imports instead.`,
          estimatedImpact: info.estimatedSize,
          suggestion: {
            title: "Use subpath imports",
            description: `Import directly from subpaths.`,
            code: `import { Component } from '${info.suggestion}'`,
          },
        });
        break;
      }
    }

    // General namespace import warning for any external package
    const isKnown =
      Object.keys(NON_TREESHAKEABLE_LIBRARIES).includes(moduleName) ||
      Object.keys(LARGE_LIBRARIES_WITH_SUBPATHS).includes(moduleName);
    if (!isKnown) {
      issues.push({
        type: "barrel-file",
        severity: "medium",
        file: relPath,
        line,
        pattern: `import * as ${localName} from '${moduleName}'`,
        description: `Namespace import (import *) of '${moduleName}' may prevent tree-shaking. Only the used members will be included if the library supports ESM, otherwise the entire library is bundled.`,
        estimatedImpact: 5000,
        suggestion: {
          title: "Use named imports",
          description: `Replace namespace import with specific named imports.`,
          code: `import { specificExport } from '${moduleName}'`,
        },
      });
    }
  }

  // 3. Non-static dynamic imports: import(variable) instead of import('./static-path')
  const dynamicImportRegex = /\bimport\s*\(\s*([^'")\s][^)]*)\s*\)/g;
  for (const match of content.matchAll(dynamicImportRegex)) {
    if (!isInCodeRegion(match.index)) continue;

    const arg = match[1].trim();
    const line = content.substring(0, match.index).split("\n").length;

    // Skip static string imports — those are fine
    if (/^['"]/.test(arg)) continue;
    // Skip template literals with only a static prefix (common and OK)
    if (/^`[^$]*`$/.test(arg)) continue;

    issues.push({
      type: "dynamic-import",
      severity: "medium",
      file: relPath,
      line,
      pattern: `import(${arg})`,
      description: `Non-static dynamic import prevents bundler optimizations. The bundler cannot determine which module to load at build time.`,
      estimatedImpact: 3000,
      suggestion: {
        title: "Use static import paths",
        description:
          "Use string literals in dynamic imports so bundlers can analyze them.",
        code: `import('./known-module') // static string path`,
      },
    });
  }

  return issues;
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

/**
 * Estimate the bundle impact of including a CJS module
 */
function estimateCJSImpact(moduleName: string): number {
  const knownSizes: Record<string, number> = {
    lodash: 72000,
    moment: 67000,
    underscore: 17000,
    jquery: 87000,
    axios: 13000,
  };

  for (const [name, size] of Object.entries(knownSizes)) {
    if (moduleName.includes(name)) {
      return size;
    }
  }

  return 5000; // Default estimate
}

/**
 * Generate an import suggestion based on module name
 */
function getImportSuggestion(moduleName: string): string {
  // Extract module base name for variable suggestion
  const baseName =
    moduleName
      .split("/")
      .pop()
      ?.replace(/[^a-zA-Z0-9]/g, "") || "module";
  return baseName;
}
