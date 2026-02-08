import type { TreeShakingIssue, WebpackStats } from "../types/index.js";

/**
 * Parse Webpack stats.json to find tree-shaking issues
 */
export function parseWebpackStats(stats: WebpackStats): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  if (!stats.modules) {
    return issues;
  }

  // Find modules that might have inefficient bundling
  for (const module of stats.modules) {
    const moduleName = module.name || "";

    // Check for problematic patterns
    if (isProblematicModule(moduleName)) {
      const issue = analyzeProblematicModule(module, moduleName);
      if (issue) {
        issues.push(issue);
      }
    }

    // Check for modules included without direct usage
    if (module.reasons && module.reasons.length === 0) {
      issues.push({
        type: "unused-export",
        severity: "low",
        file: moduleName,
        pattern: "Module with no import reasons",
        description: `Module '${moduleName}' is included but has no explicit importers. It may be an orphaned dependency.`,
        estimatedImpact: module.size || 500,
        suggestion: {
          title: "Remove unused module",
          description:
            "This module appears to be unused. Consider removing it from your dependencies.",
        },
      });
    }
  }

  // Analyze chunks for code splitting opportunities
  if (stats.chunks) {
    for (const chunk of stats.chunks) {
      if (chunk.size > 250000 && chunk.modules) {
        // Large chunk - check if it could be split
        const largeModules = chunk.modules.filter((m) => m.size > 50000);

        for (const largeModule of largeModules) {
          issues.push({
            type: "side-effect",
            severity: "medium",
            file: largeModule.name,
            pattern: `Large module in chunk ${chunk.names.join(", ") || chunk.id}`,
            description: `Module '${largeModule.name}' is ${formatBytes(largeModule.size)} and could benefit from code splitting.`,
            estimatedImpact: largeModule.size,
            suggestion: {
              title: "Consider dynamic import",
              description:
                "Use dynamic import() to lazy-load this large module.",
              code: `const Module = lazy(() => import('${largeModule.name}'))`,
            },
          });
        }
      }
    }
  }

  return issues;
}

function isProblematicModule(name: string): boolean {
  const problematicPatterns = [
    /node_modules\/lodash\//,
    /node_modules\/moment\//,
    /node_modules\/moment-timezone\//,
    /node_modules\/@fortawesome\/fontawesome-free\//,
    /node_modules\/antd\/es\/index/,
    /node_modules\/rxjs\/index/,
  ];

  return problematicPatterns.some((pattern) => pattern.test(name));
}

function analyzeProblematicModule(
  module: any,
  name: string,
): TreeShakingIssue | null {
  if (name.includes("lodash") && !name.includes("lodash-es")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: name,
      pattern: "Full lodash import",
      description:
        "Full lodash library is included. Tree-shaking is not effective with lodash.",
      estimatedImpact: module.size || 72000,
      suggestion: {
        title: "Use lodash-es or direct imports",
        description:
          "Import specific functions from lodash-es or use lodash/function paths.",
        code: `import { debounce } from 'lodash-es' // or 'lodash/debounce'`,
      },
    };
  }

  if (name.includes("moment")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: name,
      pattern: "Moment.js import",
      description:
        "Moment.js is included with all locales. Consider alternatives.",
      estimatedImpact: module.size || 67000,
      suggestion: {
        title: "Use date-fns or dayjs",
        description:
          "date-fns and dayjs are tree-shakeable alternatives to moment.",
        code: `import { format } from 'date-fns'`,
      },
    };
  }

  if (name.includes("antd") && name.includes("index")) {
    return {
      type: "barrel-file",
      severity: "high",
      file: name,
      pattern: "Antd barrel import",
      description:
        "Importing from antd barrel file includes many unused components.",
      estimatedImpact: module.size || 200000,
      suggestion: {
        title: "Import specific components",
        description: "Import antd components directly from their paths.",
        code: `import Button from 'antd/es/button'`,
      },
    };
  }

  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
