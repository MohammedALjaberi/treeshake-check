import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import type { TreeShakingIssue, IssueSeverity } from "../types/index.js";

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

  // Quick regex check for common side effect patterns
  for (const pattern of SIDE_EFFECT_PATTERNS) {
    if (pattern.test(content)) {
      const match = content.match(pattern);
      if (match) {
        const line = content.substring(0, match.index).split("\n").length;
        const matchedText = match[0].trim();

        // Skip if it's inside a function (we only care about top-level)
        if (!isTopLevel(content, match.index || 0)) {
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
    // Ignore parsing errors, rely on regex detection
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
