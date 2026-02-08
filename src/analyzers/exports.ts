import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync, existsSync, statSync } from "fs";
import { relative, dirname, resolve, join } from "path";
import type {
  TreeShakingIssue,
  ModuleExport,
  ModuleImport,
} from "../types/index.js";

interface ExportGraph {
  exports: Map<string, Set<string>>; // file -> exported names
  imports: Map<string, Map<string, string>>; // file -> (imported name -> source file)
}

/**
 * Analyze exports to find unused ones
 */
export async function analyzeUnusedExports(
  files: string[],
  projectPath: string,
): Promise<TreeShakingIssue[]> {
  const issues: TreeShakingIssue[] = [];

  // Build complete export/import graph
  const graph = buildExportGraph(files, projectPath);

  // Find exports that are never imported
  const unusedExports = findUnusedExports(graph, files, projectPath);

  for (const { file, exportName, line } of unusedExports) {
    const relPath = relative(projectPath, file);

    // Skip if it's a default export from an entry point
    if (isEntryPoint(file, projectPath)) {
      continue;
    }

    issues.push({
      type: "unused-export",
      severity: "low",
      file: relPath,
      line,
      pattern: `export ${exportName}`,
      description: `'${exportName}' is exported but never imported in the analyzed codebase.`,
      estimatedImpact: 500,
      suggestion: {
        title: "Remove unused export",
        description: `If '${exportName}' is not used externally, consider removing it or marking it as internal.`,
      },
    });
  }

  return issues;
}

function buildExportGraph(files: string[], projectPath: string): ExportGraph {
  const exports = new Map<string, Set<string>>();
  const imports = new Map<string, Map<string, string>>();

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const fileExports = new Set<string>();
      const fileImports = new Map<string, string>();

      const ast = acorn.parse(content, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
      });

      walk.simple(ast, {
        ExportNamedDeclaration(node: any) {
          // export { a, b }
          if (node.specifiers) {
            for (const spec of node.specifiers) {
              const exportedName = spec.exported?.name || spec.local?.name;
              if (exportedName) {
                fileExports.add(exportedName);
              }
            }
          }
          // export const/let/var/function/class
          if (node.declaration) {
            if (node.declaration.declarations) {
              for (const decl of node.declaration.declarations) {
                if (decl.id?.name) {
                  fileExports.add(decl.id.name);
                }
              }
            } else if (node.declaration.id?.name) {
              fileExports.add(node.declaration.id.name);
            }
          }
        },
        ExportDefaultDeclaration() {
          fileExports.add("default");
        },
        ExportAllDeclaration(node: any) {
          // export * from "..."
          if (node.source?.value) {
            fileExports.add(`* from ${node.source.value}`);
          }
        },
        ImportDeclaration(node: any) {
          if (!node.source?.value) return;

          const sourcePath = node.source.value;

          for (const spec of node.specifiers || []) {
            if (spec.type === "ImportSpecifier") {
              const importedName = spec.imported?.name;
              if (importedName) {
                fileImports.set(
                  importedName,
                  resolveImportPath(file, sourcePath),
                );
              }
            } else if (spec.type === "ImportDefaultSpecifier") {
              fileImports.set("default", resolveImportPath(file, sourcePath));
            } else if (spec.type === "ImportNamespaceSpecifier") {
              fileImports.set("*", resolveImportPath(file, sourcePath));
            }
          }
        },
      });

      exports.set(file, fileExports);
      imports.set(file, fileImports);
    } catch {
      // Skip files that can't be parsed
    }
  }

  return { exports, imports };
}

function findUnusedExports(
  graph: ExportGraph,
  files: string[],
  projectPath: string,
): Array<{ file: string; exportName: string; line: number }> {
  const unusedExports: Array<{
    file: string;
    exportName: string;
    line: number;
  }> = [];

  // Collect all imported names across the codebase
  const allImports = new Map<string, Set<string>>(); // source file -> imported names

  for (const [importingFile, fileImports] of graph.imports) {
    for (const [importedName, sourceFile] of fileImports) {
      if (!allImports.has(sourceFile)) {
        allImports.set(sourceFile, new Set());
      }
      allImports.get(sourceFile)!.add(importedName);
    }
  }

  // Check each export against imports
  for (const [file, fileExports] of graph.exports) {
    const usedInFile = allImports.get(file) || new Set();

    for (const exportName of fileExports) {
      // Skip wildcard re-exports
      if (exportName.startsWith("*")) continue;

      // Check if this export is used
      const isUsed =
        usedInFile.has(exportName) ||
        usedInFile.has("*") || // namespace import uses all
        (exportName === "default" && usedInFile.has("default"));

      if (!isUsed) {
        unusedExports.push({
          file,
          exportName,
          line: getExportLine(file, exportName),
        });
      }
    }
  }

  return unusedExports;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];

function resolveImportPath(fromFile: string, importPath: string): string {
  // Handle relative imports
  if (importPath.startsWith(".")) {
    const dir = dirname(fromFile);
    const resolved = resolve(dir, importPath);

    // 1. Exact path exists — could be a file or a directory
    if (existsSync(resolved)) {
      try {
        if (statSync(resolved).isDirectory()) {
          // Resolve directory to its index file (e.g. ./components -> ./components/index.ts)
          return resolveIndexFile(resolved) || resolved;
        }
      } catch {
        // statSync failed, treat as a file
      }
      return resolved;
    }

    // 2. Try adding extensions (e.g. ./utils -> ./utils.ts)
    for (const ext of RESOLVE_EXTENSIONS) {
      const withExt = resolved + ext;
      if (existsSync(withExt)) {
        return withExt;
      }
    }

    // 3. TypeScript convention: .js/.jsx in import maps to .ts/.tsx on disk
    if (resolved.endsWith(".js")) {
      const base = resolved.slice(0, -3);
      for (const ext of [".ts", ".tsx", ".js"]) {
        if (existsSync(base + ext)) return base + ext;
      }
    } else if (resolved.endsWith(".jsx")) {
      const base = resolved.slice(0, -4);
      for (const ext of [".tsx", ".jsx"]) {
        if (existsSync(base + ext)) return base + ext;
      }
    }

    // 4. Try as a directory with index file (e.g. ./components -> ./components/index.ts)
    const indexResolved = resolveIndexFile(resolved);
    if (indexResolved) return indexResolved;

    // Fallback: return as-is (won't match, so the import is treated as external)
    return resolved;
  }

  // For node_modules / bare specifiers, return as-is
  return importPath;
}

/**
 * Resolve a directory path to its index file
 */
function resolveIndexFile(dirPath: string): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = join(dirPath, `index${ext}`);
    if (existsSync(indexPath)) {
      return indexPath;
    }
  }
  return null;
}

function isEntryPoint(file: string, projectPath: string): boolean {
  const relPath = relative(projectPath, file).toLowerCase();

  // Common entry point patterns
  const entryPatterns = [
    /^src\/index\./,
    /^src\/main\./,
    /^src\/app\./,
    /^index\./,
    /^main\./,
  ];

  return entryPatterns.some((pattern) => pattern.test(relPath));
}

function getExportLine(file: string, exportName: string): number {
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(`export`) && line.includes(exportName)) {
        return i + 1;
      }
    }
  } catch {
    // Ignore
  }

  return 0;
}
