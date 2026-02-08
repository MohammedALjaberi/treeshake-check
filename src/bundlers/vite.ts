import type { TreeShakingIssue, RollupBundleInfo } from "../types/index.js";

/**
 * Parse Vite/Rollup stats to find tree-shaking issues
 * Vite uses Rollup under the hood, so we analyze rollup-style output
 */
export function parseViteStats(stats: any): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  // Handle rollup-plugin-visualizer output format
  if (stats.tree) {
    return analyzeVisualizerOutput(stats);
  }

  // Handle direct Rollup bundle info
  if (stats.modules || Array.isArray(stats)) {
    return analyzeRollupBundle(stats);
  }

  // Handle Vite's internal stats format (if available)
  if (stats.chunks) {
    return analyzeViteChunks(stats.chunks);
  }

  return issues;
}

function analyzeVisualizerOutput(stats: any): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  function traverseTree(node: any, path: string = ""): void {
    const currentPath = path ? `${path}/${node.name}` : node.name;

    // Check for problematic patterns
    if (node.name && isProblematicModule(node.name)) {
      const issue = createIssueForModule(node.name, node.value || 0);
      if (issue) {
        issues.push(issue);
      }
    }

    // Large modules that could be split
    if (
      node.value &&
      node.value > 50000 &&
      !node.name.includes("node_modules")
    ) {
      issues.push({
        type: "side-effect",
        severity: "medium",
        file: currentPath,
        pattern: `Large module: ${formatBytes(node.value)}`,
        description: `Module is ${formatBytes(node.value)} and could benefit from code splitting.`,
        estimatedImpact: node.value,
        suggestion: {
          title: "Consider code splitting",
          description: "Use dynamic imports to lazy-load this module.",
          code: `const Module = lazy(() => import('${node.name}'))`,
        },
      });
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        traverseTree(child, currentPath);
      }
    }
  }

  if (stats.tree) {
    traverseTree(stats.tree);
  }

  return issues;
}

function analyzeRollupBundle(
  stats: RollupBundleInfo | RollupBundleInfo[],
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];
  const bundles = Array.isArray(stats) ? stats : [stats];

  for (const bundle of bundles) {
    if (!bundle.modules) continue;

    for (const [modulePath, moduleInfo] of Object.entries(bundle.modules)) {
      const originalSize = moduleInfo.originalLength || 0;
      const renderedSize = moduleInfo.renderedLength || 0;

      // Check for modules where tree-shaking had minimal effect
      if (originalSize > 5000 && renderedSize > originalSize * 0.9) {
        issues.push({
          type: "side-effect",
          severity: "low",
          file: modulePath,
          pattern: `Minimal tree-shaking: ${Math.round((renderedSize / originalSize) * 100)}% retained`,
          description: `Most of '${modulePath}' is included in the bundle. Check for side effects.`,
          estimatedImpact: renderedSize,
          suggestion: {
            title: "Review for side effects",
            description:
              "Check if this module has top-level side effects preventing tree-shaking.",
          },
        });
      }

      // Check for known problematic modules
      if (isProblematicModule(modulePath)) {
        const issue = createIssueForModule(modulePath, renderedSize);
        if (issue) {
          issues.push(issue);
        }
      }
    }
  }

  return issues;
}

function analyzeViteChunks(chunks: any[]): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  for (const chunk of chunks) {
    const chunkSize = chunk.code?.length || 0;

    // Large vendor chunks
    if (chunk.name?.includes("vendor") && chunkSize > 500000) {
      issues.push({
        type: "barrel-file",
        severity: "high",
        file: chunk.fileName || chunk.name,
        pattern: `Large vendor chunk: ${formatBytes(chunkSize)}`,
        description:
          "Vendor chunk is very large. Consider splitting by frequency of use.",
        estimatedImpact: chunkSize,
        suggestion: {
          title: "Configure manual chunks",
          description:
            "Use Vite's manualChunks to split vendor code strategically.",
          code: `// vite.config.ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        react: ['react', 'react-dom'],
        // other chunks...
      }
    }
  }
}`,
        },
      });
    }
  }

  return issues;
}

function isProblematicModule(name: string): boolean {
  const patterns = [
    /node_modules\/lodash\//,
    /node_modules\/moment/,
    /node_modules\/antd\/es\/index/,
    /node_modules\/@mui\/material\/index/,
  ];
  return patterns.some((p) => p.test(name));
}

function createIssueForModule(
  name: string,
  size: number,
): TreeShakingIssue | null {
  if (name.includes("lodash") && !name.includes("lodash-es")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: name,
      pattern: "lodash (CommonJS)",
      description:
        "lodash CommonJS bundle detected. Use lodash-es for tree-shaking.",
      estimatedImpact: size,
      suggestion: {
        title: "Switch to lodash-es",
        description: "Replace lodash with lodash-es.",
        code: `import { debounce } from 'lodash-es'`,
      },
    };
  }

  if (name.includes("moment")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: name,
      pattern: "moment.js",
      description: "moment.js does not tree-shake. Use date-fns or dayjs.",
      estimatedImpact: size,
      suggestion: {
        title: "Use date-fns or dayjs",
        description: "Tree-shakeable alternatives to moment.",
        code: `import { format } from 'date-fns'`,
      },
    };
  }

  if (name.includes("antd") && name.includes("index")) {
    return {
      type: "barrel-file",
      severity: "high",
      file: name,
      pattern: "antd barrel import",
      description:
        "Importing from antd barrel includes many unused components.",
      estimatedImpact: size,
      suggestion: {
        title: "Import specific components",
        description: "Import from component paths directly.",
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
