import { readFileSync } from "fs";
import { relative } from "path";
import type { TreeShakingIssue } from "../types/index.js";

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

  // Detect patterns
  const hasCJS = Object.entries(CJS_PATTERNS).some(([_, pattern]) =>
    pattern.test(content),
  );
  const hasESM = Object.entries(ESM_PATTERNS).some(([_, pattern]) =>
    pattern.test(content),
  );

  // Mixed module system usage
  if (hasCJS && hasESM) {
    // Exclude template literals like require('${...}')
    const requireMatches = content.matchAll(
      /\brequire\s*\(\s*['"](?!\$\{)([^'"$]+)['"]\s*\)/g,
    );
    for (const match of requireMatches) {
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
    if (pattern.test(content)) {
      const match = content.match(pattern);
      const line = match
        ? content.substring(0, match.index).split("\n").length
        : 0;

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

  return issues;
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
