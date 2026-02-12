import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import type { TreeShakingIssue, IssueSeverity } from "../types/index.js";
import { stripLiteralsAndComments } from "../utils/strip-literals.js";

// Known side-effect patterns at the top level
const SIDE_EFFECT_PATTERNS = [
  /^\s*console\./m,
  /^\s*window\./m,
  /^\s*document\./m,
  /^\s*globalThis\./m,
  /^\s*global\./m,
  /^\s*localStorage\./m,
  /^\s*sessionStorage\./m,
];

// Known side-effect function calls
const SIDE_EFFECT_CALLS = new Set([
  "require",
  "fetch",
  "setTimeout",
  "setInterval",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "alert",
  "confirm",
  "prompt",
]);

// Bare import pattern: `import './file'` or `import 'polyfill'` (no specifiers)
const BARE_IMPORT_REGEX =
  /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

// Known CSS / style extensions that are expected bare imports
const STYLE_EXTENSIONS = /\.(css|scss|sass|less|styl|stylus)$/;

// Known polyfill / side-effect modules that should be flagged
const KNOWN_SIDE_EFFECT_MODULES = [
  "core-js",
  "regenerator-runtime",
  "whatwg-fetch",
  "raf/polyfill",
  "intersection-observer",
  "resize-observer-polyfill",
];

/**
 * Analyze files for side effects that prevent tree-shaking
 */
export async function analyzeSideEffects(
  files: string[],
  projectPath: string,
): Promise<TreeShakingIssue[]> {
  const issues: TreeShakingIssue[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const fileIssues = analyzeFileSideEffects(content, file, projectPath);
      issues.push(...fileIssues);
    } catch {
      // Skip files that can't be read
    }
  }

  return issues;
}

function analyzeFileSideEffects(
  content: string,
  filePath: string,
  projectPath: string,
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];
  const relPath = relative(projectPath, filePath);
  const strippedContent = stripLiteralsAndComments(content);

  // Quick regex check for common side effect patterns
  for (const pattern of SIDE_EFFECT_PATTERNS) {
    if (pattern.test(strippedContent)) {
      const match = strippedContent.match(pattern);
      if (match) {
        const line = strippedContent.substring(0, match.index).split("\n").length;
        const matchedText = match[0].trim();

        // Skip if it's inside a function (we only care about top-level)
        if (!isTopLevel(strippedContent, match.index || 0)) {
          continue;
        }

        issues.push({
          type: "side-effect",
          severity: "medium",
          file: relPath,
          line,
          pattern: matchedText,
          description: `Top-level side effect detected. This code runs when the module is imported, preventing tree-shaking.`,
          estimatedImpact: 500,
          suggestion: {
            title: "Move side effect into a function",
            description:
              "Wrap side effects in functions that are called explicitly.",
            code: `export function init() { ${matchedText}... }`,
          },
        });
      }
    }
  }

  // AST-based analysis for more complex patterns
  try {
    const ast = acorn.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });

    walk.simple(ast, {
      ExpressionStatement(node: any) {
        // Check for top-level function calls
        if (node.expression.type === "CallExpression") {
          const callee = node.expression.callee;
          let calleeName = "";

          if (callee.type === "Identifier") {
            calleeName = callee.name;
          } else if (
            callee.type === "MemberExpression" &&
            callee.property.type === "Identifier"
          ) {
            calleeName = callee.property.name;
          }

          if (SIDE_EFFECT_CALLS.has(calleeName)) {
            issues.push({
              type: "side-effect",
              severity: "high",
              file: relPath,
              line: node.loc?.start?.line,
              pattern: `${calleeName}() at top level`,
              description: `Top-level call to ${calleeName}() is a side effect that prevents tree-shaking.`,
              estimatedImpact: 1000,
              suggestion: {
                title: "Move to an initialization function",
                description: `Wrap ${calleeName}() call in an exported function.`,
              },
            });
          }
        }
      },
      AssignmentExpression(node: any) {
        // Check for global assignments at top level
        const left = node.left;
        if (left.type === "MemberExpression") {
          const obj = left.object;
          if (
            obj.type === "Identifier" &&
            ["window", "global", "globalThis"].includes(obj.name)
          ) {
            issues.push({
              type: "side-effect",
              severity: "high",
              file: relPath,
              line: node.loc?.start?.line,
              pattern: `Global assignment: ${obj.name}.${left.property?.name || "..."}`,
              description:
                "Global variable assignment is a side effect that prevents tree-shaking.",
              estimatedImpact: 500,
              suggestion: {
                title: "Avoid global assignments",
                description:
                  "Use module-scoped variables or dependency injection instead.",
              },
            });
          }
        }
      },
    });
  } catch {
    // AST parsing failed (likely TypeScript / JSX) — use regex fallback
    // for side-effect function calls at top level
    const topLevelCallRegex =
      /^(?:(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*)?(setTimeout|setInterval|addEventListener|fetch|alert|confirm|prompt)\s*\(/gm;
    for (const match of content.matchAll(topLevelCallRegex)) {
      const calleeName = match[1];
      const line = content.substring(0, match.index).split("\n").length;
      if (isTopLevel(content, match.index || 0)) {
        issues.push({
          type: "side-effect",
          severity: "high",
          file: relPath,
          line,
          pattern: `${calleeName}() at top level`,
          description: `Top-level call to ${calleeName}() is a side effect that prevents tree-shaking.`,
          estimatedImpact: 1000,
          suggestion: {
            title: "Move to an initialization function",
            description: `Wrap ${calleeName}() call in an exported function.`,
          },
        });
      }
    }

    // Regex fallback for global assignments: window.X = ... / global.X = ...
    const globalAssignRegex =
      /^\s*(window|global|globalThis)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gm;
    for (const match of content.matchAll(globalAssignRegex)) {
      const objName = match[1];
      const propName = match[2];
      const line = content.substring(0, match.index).split("\n").length;
      if (isTopLevel(content, match.index || 0)) {
        issues.push({
          type: "side-effect",
          severity: "high",
          file: relPath,
          line,
          pattern: `Global assignment: ${objName}.${propName}`,
          description:
            "Global variable assignment is a side effect that prevents tree-shaking.",
          estimatedImpact: 500,
          suggestion: {
            title: "Avoid global assignments",
            description:
              "Use module-scoped variables or dependency injection instead.",
          },
        });
      }
    }
  }

  // ── Bare / side-effect imports ────────────────────────────────────────
  // Detect `import './file'` and `import 'polyfill'` style imports
  // Use content for value extraction; the `^` anchor + `import` keyword
  // provide enough context to avoid false positives from strings
  const bareImportRegex = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
  for (const match of content.matchAll(bareImportRegex)) {
    // Validate against strippedContent
    if (match.index !== undefined && strippedContent[match.index + match[0].search(/import/)] === " ") continue;
    const importPath = match[1];
    const line = content.substring(0, match.index).split("\n").length;

    // Skip CSS/style imports — those are expected bare imports
    if (STYLE_EXTENSIONS.test(importPath)) continue;

    const isKnownPolyfill = KNOWN_SIDE_EFFECT_MODULES.some((mod) =>
      importPath.startsWith(mod),
    );

    const severity: IssueSeverity = isKnownPolyfill ? "medium" : "low";

    issues.push({
      type: "side-effect",
      severity,
      file: relPath,
      line,
      pattern: `import '${importPath}'`,
      description: `Bare import of '${importPath}' is a side-effect import. The entire module is executed on import, which prevents tree-shaking of this dependency.${isKnownPolyfill ? " Consider loading this polyfill conditionally." : ""}`,
      estimatedImpact: isKnownPolyfill ? 5000 : 1000,
      suggestion: {
        title: isKnownPolyfill
          ? "Load polyfill conditionally"
          : "Review if side-effect import is necessary",
        description: isKnownPolyfill
          ? "Load polyfills only when needed, or use a service like polyfill.io."
          : "If this import has exports you use, import them explicitly. If it's only for side effects, document why.",
        code: isKnownPolyfill
          ? `if (!('fetch' in window)) { await import('${importPath}') }`
          : undefined,
      },
    });
  }

  return issues;
}

/**
 * Check if a position in the content is at the top level (not inside a function)
 */
function isTopLevel(content: string, position: number): boolean {
  const beforePos = content.substring(0, position);

  // Count braces to determine nesting level
  // This is a simplified heuristic
  const openBraces = (beforePos.match(/\{/g) || []).length;
  const closeBraces = (beforePos.match(/\}/g) || []).length;

  // If roughly balanced, we're at top level
  return Math.abs(openBraces - closeBraces) <= 1;
}

/**
 * Check package.json for sideEffects configuration
 */
export async function checkSideEffectsConfig(
  projectPath: string,
): Promise<TreeShakingIssue[]> {
  const issues: TreeShakingIssue[] = [];
  const packageJsonPath = join(projectPath, "package.json");

  if (!existsSync(packageJsonPath)) {
    return issues;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    // Check if sideEffects is configured
    if (!("sideEffects" in packageJson)) {
      issues.push({
        type: "missing-sideeffects-config",
        severity: "medium",
        file: "package.json",
        pattern: "missing sideEffects field",
        description:
          "No sideEffects field in package.json. Bundlers cannot optimize tree-shaking without this hint.",
        estimatedImpact: 5000,
        suggestion: {
          title: "Add sideEffects field",
          description:
            "Add sideEffects: false if your code has no side effects, or list files with side effects.",
          code: `"sideEffects": false // or ["*.css", "*.scss"]`,
        },
      });
    } else if (packageJson.sideEffects === true) {
      issues.push({
        type: "side-effect",
        severity: "high",
        file: "package.json",
        pattern: "sideEffects: true",
        description:
          "sideEffects is set to true, which prevents all tree-shaking.",
        estimatedImpact: 10000,
        suggestion: {
          title: "Optimize sideEffects configuration",
          description:
            "Set sideEffects to false or specify only files that have side effects.",
          code: `"sideEffects": ["*.css", "./src/polyfills.js"]`,
        },
      });
    }
  } catch {
    // Ignore JSON parsing errors
  }

  return issues;
}
