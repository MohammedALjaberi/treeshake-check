import type { TreeShakingIssue, EsbuildMetafile } from "../types/index.js";

/**
 * Parse esbuild metafile to find tree-shaking issues
 */
export function parseEsbuildMetafile(
  metafile: EsbuildMetafile,
): TreeShakingIssue[] {
  const issues: TreeShakingIssue[] = [];

  if (!metafile.inputs || !metafile.outputs) {
    return issues;
  }

  // Analyze inputs for problematic patterns
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    // Check for large modules
    if (input.bytes > 100000) {
      const issue = analyzeLargeInput(inputPath, input);
      if (issue) {
        issues.push(issue);
      }
    }

    // Check for CommonJS imports in ESM context
    for (const importInfo of input.imports || []) {
      if (importInfo.kind === "require-call") {
        issues.push({
          type: "commonjs-module",
          severity: "medium",
          file: inputPath,
          pattern: `require('${importInfo.path}')`,
          description: `CommonJS require() prevents optimal tree-shaking for '${importInfo.path}'.`,
          estimatedImpact: 2000,
          suggestion: {
            title: "Convert to ESM import",
            description:
              "Use ESM import instead of require() for better tree-shaking.",
            code: `import module from '${importInfo.path}'`,
          },
        });
      }
    }
  }

  // Analyze outputs for inefficiencies
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (!output.entryPoint) continue;

    // Check if large portions of inputs are unused
    for (const [inputPath, inputInfo] of Object.entries(output.inputs || {})) {
      const originalSize = metafile.inputs[inputPath]?.bytes || 0;
      const usedSize = inputInfo.bytesInOutput;

      // If less than 50% of a large module is used, flag it
      if (originalSize > 10000 && usedSize < originalSize * 0.5) {
        const wastedBytes = originalSize - usedSize;

        issues.push({
          type: "unused-export",
          severity: wastedBytes > 50000 ? "high" : "medium",
          file: inputPath,
          pattern: `Only ${Math.round((usedSize / originalSize) * 100)}% used`,
          description: `Only ${formatBytes(usedSize)} of ${formatBytes(originalSize)} from '${inputPath}' is used in the output.`,
          estimatedImpact: wastedBytes,
          suggestion: {
            title: "Import only what you need",
            description:
              "Consider importing specific exports instead of the entire module.",
          },
        });
      }
    }

    // Check for modules that might not tree-shake well
    const problematicInputs = Object.keys(output.inputs || {}).filter(
      isProblematicPath,
    );
    for (const problematicPath of problematicInputs) {
      const issue = analyzeProblematicPath(
        problematicPath,
        output.inputs[problematicPath],
      );
      if (issue) {
        issues.push(issue);
      }
    }
  }

  return issues;
}

function analyzeLargeInput(
  path: string,
  input: { bytes: number; imports: any[] },
): TreeShakingIssue | null {
  // Check for known problematic libraries
  if (path.includes("node_modules/lodash/") && !path.includes("lodash-es")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: path,
      pattern: "lodash (CommonJS)",
      description:
        "lodash CommonJS bundle is included. Use lodash-es for tree-shaking.",
      estimatedImpact: input.bytes,
      suggestion: {
        title: "Switch to lodash-es",
        description:
          "Replace lodash with lodash-es for proper tree-shaking support.",
        code: `import { debounce } from 'lodash-es'`,
      },
    };
  }

  if (path.includes("node_modules/moment/")) {
    return {
      type: "commonjs-module",
      severity: "critical",
      file: path,
      pattern: "moment.js",
      description:
        "moment.js does not support tree-shaking. Consider date-fns or dayjs.",
      estimatedImpact: input.bytes,
      suggestion: {
        title: "Use date-fns or dayjs",
        description: "These libraries are tree-shakeable alternatives.",
        code: `import { format } from 'date-fns'`,
      },
    };
  }

  return null;
}

function isProblematicPath(path: string): boolean {
  const patterns = [
    /node_modules\/lodash\//,
    /node_modules\/moment/,
    /node_modules\/@material-ui\/core\/esm\/index/,
    /node_modules\/antd\/es\/index/,
  ];
  return patterns.some((p) => p.test(path));
}

function analyzeProblematicPath(
  path: string,
  inputInfo: { bytesInOutput: number },
): TreeShakingIssue | null {
  if (path.includes("antd") && path.includes("index")) {
    return {
      type: "barrel-file",
      severity: "high",
      file: path,
      pattern: "antd barrel import",
      description:
        "Importing from antd barrel file includes many unused components.",
      estimatedImpact: inputInfo.bytesInOutput,
      suggestion: {
        title: "Import specific components",
        description: "Import antd components directly.",
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
