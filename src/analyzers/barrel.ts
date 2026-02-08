import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync } from "fs";
import { basename, relative } from "path";
import type { TreeShakingIssue, IssueSeverity } from "../types/index.js";

/**
 * Analyzes files for barrel file patterns that can break tree-shaking
 */
export async function analyzeBarrelFiles(
  files: string[],
  projectPath: string,
): Promise<TreeShakingIssue[]> {
  const issues: TreeShakingIssue[] = [];

  for (const file of files) {
    const fileName = basename(file);
    // Only check index files (common barrel file pattern)
    if (!fileName.match(/^index\.(js|ts|jsx|tsx|mjs|mts)$/)) {
      continue;
    }

    try {
      const content = readFileSync(file, "utf-8");
      const fileIssues = analyzeBarrelContent(content, file, projectPath);
      issues.push(...fileIssues);
    } catch {
      // Skip files that can't be read
    }
  }

  return issues;
}

function analyzeBarrelContent(
  content: string,
  filePath: string,
  projectPath: string,
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];
  const relPath = relative(projectPath, filePath);

  // Count re-exports to determine if this is a barrel file
  let reexportCount = 0;
  let wildcardReexportCount = 0;
  const wildcardSources: Array<{ source: string; line: number }> = [];

  try {
    const ast = acorn.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });

    walk.simple(ast, {
      ExportAllDeclaration(node: any) {
        wildcardReexportCount++;
        reexportCount++;
        wildcardSources.push({
          source: node.source?.value || "unknown",
          line: node.loc?.start?.line || 0,
        });
      },
      ExportNamedDeclaration(node: any) {
        if (node.source) {
          reexportCount++;
        }
      },
    });
  } catch {
    // Fall back to regex-based detection for files that fail to parse
    const wildcardMatches = content.matchAll(
      /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
    );
    for (const match of wildcardMatches) {
      wildcardReexportCount++;
      reexportCount++;
      const line = content.substring(0, match.index).split("\n").length;
      wildcardSources.push({ source: match[1], line });
    }

    const namedReexportMatches = content.matchAll(
      /export\s+\{[^}]+\}\s+from\s+['"][^'"]+['"]/g,
    );
    for (const _match of namedReexportMatches) {
      reexportCount++;
    }
  }

  // Only warn about barrel files with wildcard re-exports
  if (wildcardReexportCount > 0) {
    for (const { source, line } of wildcardSources) {
      const severity: IssueSeverity =
        wildcardReexportCount > 3 ? "critical" : "high";

      issues.push({
        type: "wildcard-reexport",
        severity,
        file: relPath,
        line,
        pattern: `export * from '${source}'`,
        description: `Wildcard re-export prevents tree-shaking. All exports from '${source}' will be included even if unused.`,
        estimatedImpact: estimateWildcardImpact(source),
        suggestion: {
          title: "Use explicit named exports",
          description:
            "Replace wildcard re-exports with explicit named exports to enable tree-shaking.",
          code: `export { SpecificExport } from '${source}'`,
        },
      });
    }
  }

  // Warn about barrel files in general if they have many re-exports
  if (reexportCount > 5 && wildcardReexportCount === 0) {
    issues.push({
      type: "barrel-file",
      severity: "medium",
      file: relPath,
      pattern: `${reexportCount} re-exports in barrel file`,
      description: `Large barrel file with ${reexportCount} re-exports. Some bundlers may include all modules when importing from this barrel.`,
      estimatedImpact: reexportCount * 500, // Rough estimate
      suggestion: {
        title: "Consider direct imports",
        description:
          "Import directly from source modules instead of through the barrel file.",
        code: `import { Component } from './components/Component' // instead of './components'`,
      },
    });
  }

  return issues;
}

/**
 * Estimate the bundle size impact of a wildcard re-export
 */
function estimateWildcardImpact(source: string): number {
  // Rough heuristics based on common patterns
  if (source.includes("lodash")) return 25000;
  if (source.includes("icons") || source.includes("Icon")) return 50000;
  if (source.includes("utils") || source.includes("helpers")) return 5000;
  if (source.includes("components")) return 10000;

  // Default estimate
  return 3000;
}
