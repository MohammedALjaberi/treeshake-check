import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { readFileSync, existsSync, statSync } from "fs";
import { relative, dirname, resolve, join } from "path";
import type {
  TreeShakingIssue,
  ModuleExport,
  ModuleImport,
} from "../types/index.js";
import { stripLiteralsAndComments } from "../utils/strip-literals.js";

interface ImportRecord {
  importedName: string;
  sourceFile: string;
}

interface ExportGraph {
  exports: Map<string, Set<string>>; // file -> exported names
  imports: Map<string, ImportRecord[]>; // file -> list of imports
}

/**
 * Analyze exports to find unused ones and circular dependencies
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

  // Detect circular dependencies
  const cycles = findCircularDependencies(graph, files, projectPath);
  for (const cycle of cycles) {
    const relFiles = cycle.map((f) => relative(projectPath, f));
    const cycleStr = relFiles.join(" → ") + " → " + relFiles[0];

    issues.push({
      type: "circular-dependency",
      severity: cycle.length <= 2 ? "high" : "critical",
      file: relFiles[0],
      pattern: `circular: ${relFiles.length} files`,
      description: `Circular dependency detected: ${cycleStr}. Circular imports can prevent bundlers from properly tree-shaking modules in the cycle.`,
      estimatedImpact: cycle.length * 2000,
      suggestion: {
        title: "Break the dependency cycle",
        description:
          "Extract shared code into a separate module that both files can import from, or restructure the imports to remove the cycle.",
      },
    });
  }

  return issues;
}

function buildExportGraph(files: string[], projectPath: string): ExportGraph {
  const exports = new Map<string, Set<string>>();
  const imports = new Map<string, ImportRecord[]>();

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const fileExports = new Set<string>();
      const fileImports: ImportRecord[] = [];

      let parsed = false;
      try {
        const ast = acorn.parse(content, {
          ecmaVersion: "latest",
          sourceType: "module",
          locations: true,
        });

        walk.simple(ast, {
          ExportNamedDeclaration(node: any) {
            if (node.specifiers) {
              for (const spec of node.specifiers) {
                const exportedName = spec.exported?.name || spec.local?.name;
                if (exportedName) {
                  fileExports.add(exportedName);
                }

                // Re-export: export { X } from './module'
                // This also counts as an import from the source module
                if (node.source?.value) {
                  const localName = spec.local?.name;
                  if (localName) {
                    fileImports.push({
                      importedName: localName,
                      sourceFile: resolveImportPath(file, node.source.value),
                    });
                  }
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

              // Wildcard re-export counts as a namespace import from the source
              fileImports.push({
                importedName: "*",
                sourceFile: resolveImportPath(file, node.source.value),
              });
            }
          },
          ImportDeclaration(node: any) {
            if (!node.source?.value) return;

            const sourcePath = node.source.value;

            for (const spec of node.specifiers || []) {
              if (spec.type === "ImportSpecifier") {
                const importedName = spec.imported?.name;
                if (importedName) {
                  fileImports.push({
                    importedName,
                    sourceFile: resolveImportPath(file, sourcePath),
                  });
                }
              } else if (spec.type === "ImportDefaultSpecifier") {
                fileImports.push({
                  importedName: "default",
                  sourceFile: resolveImportPath(file, sourcePath),
                });
              } else if (spec.type === "ImportNamespaceSpecifier") {
                fileImports.push({
                  importedName: "*",
                  sourceFile: resolveImportPath(file, sourcePath),
                });
              }
            }
          },
        });

        parsed = true;
      } catch {
        // Acorn couldn't parse the file (likely TypeScript / JSX)
        // Fall back to regex-based extraction
      }

      if (!parsed) {
        const strippedContent = stripLiteralsAndComments(content);
        extractExportsAndImportsViaRegex(content, strippedContent, file, fileExports, fileImports);
      }

      exports.set(file, fileExports);
      imports.set(file, fileImports);
    } catch {
      // Skip files that can't be read at all
    }
  }

  return { exports, imports };
}

/**
 * Regex-based fallback for extracting exports and imports from files
 * that acorn can't parse (TypeScript, JSX, TSX, etc.)
 *
 * Uses strippedContent (comments/strings replaced with spaces) to find match
 * positions, then reads actual values from the original content.
 */
function extractExportsAndImportsViaRegex(
  content: string,
  strippedContent: string,
  file: string,
  fileExports: Set<string>,
  fileImports: ImportRecord[],
): void {
  // Helper: verify a match is in real code (not inside a string/comment)
  function inCode(index: number | undefined): boolean {
    if (index === undefined) return true;
    return strippedContent[index] !== " ";
  }

  // ── Exports ────────────────────────────────────────────────────────

  // export default ...
  if (/\bexport\s+default\b/.test(strippedContent)) {
    fileExports.add("default");
  }

  // export const/let/var/function/class NAME
  const namedExportDeclRegex =
    /\bexport\s+(?:const|let|var|function\*?|class|enum|abstract\s+class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  for (const match of strippedContent.matchAll(namedExportDeclRegex)) {
    if (!inCode(match.index)) continue;
    fileExports.add(match[1]);
  }

  // export { A, B, C } or export { A, B } from './module'
  // Run on content but validate position against strippedContent
  const exportBraceRegex = /\bexport\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/g;
  for (const match of content.matchAll(exportBraceRegex)) {
    if (!inCode(match.index)) continue;
    const names = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
    for (const name of names) {
      if (name) fileExports.add(name);
    }
    // Re-export also creates an import from the source
    if (match[2]) {
      const source = match[2];
      const localNames = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      for (const localName of localNames) {
        if (localName) {
          fileImports.push({
            importedName: localName,
            sourceFile: resolveImportPath(file, source),
          });
        }
      }
    }
  }

  // export * from './module'
  const exportAllRegex = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(exportAllRegex)) {
    if (!inCode(match.index)) continue;
    fileExports.add(`* from ${match[1]}`);
    fileImports.push({
      importedName: "*",
      sourceFile: resolveImportPath(file, match[1]),
    });
  }

  // export type / export interface (TS-only, still counts as exports)
  const tsExportTypeRegex =
    /\bexport\s+(?:type|interface)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  for (const match of strippedContent.matchAll(tsExportTypeRegex)) {
    if (!inCode(match.index)) continue;
    fileExports.add(match[1]);
  }

  // ── Imports ────────────────────────────────────────────────────────

  // import { A, B } from './module' (skip 'import type')
  const namedImportRegex =
    /\bimport\s+(?!type\b)\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(namedImportRegex)) {
    if (!inCode(match.index)) continue;
    const source = match[2];
    const names = match[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (name) {
        fileImports.push({
          importedName: name,
          sourceFile: resolveImportPath(file, source),
        });
      }
    }
  }

  // import X from './module' (default import, skip 'import type')
  const defaultImportRegex =
    /\bimport\s+(?!type\b)([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(defaultImportRegex)) {
    if (!inCode(match.index)) continue;
    fileImports.push({
      importedName: "default",
      sourceFile: resolveImportPath(file, match[2]),
    });
  }

  // import * as X from './module'
  const namespaceImportRegex =
    /\bimport\s+\*\s+as\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(namespaceImportRegex)) {
    if (!inCode(match.index)) continue;
    fileImports.push({
      importedName: "*",
      sourceFile: resolveImportPath(file, match[1]),
    });
  }
}

/**
 * Detect circular dependencies in the import graph using DFS
 */
function findCircularDependencies(
  graph: ExportGraph,
  files: string[],
  projectPath: string,
): string[][] {
  // Build adjacency list: file → set of imported files (local only)
  const adjacency = new Map<string, Set<string>>();
  const fileSet = new Set(files);

  for (const [file, fileImports] of graph.imports) {
    const deps = new Set<string>();
    for (const { sourceFile } of fileImports) {
      // Only include local files (not node_modules / bare specifiers)
      if (fileSet.has(sourceFile)) {
        deps.add(sourceFile);
      }
    }
    adjacency.set(file, deps);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const reportedEdges = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        const cycle = path.slice(cycleStart);

        // Deduplicate: use a canonical key from the smallest rotation
        const edgeKey = cycle
          .map((f) => relative(projectPath, f))
          .sort()
          .join("|");

        if (!reportedEdges.has(edgeKey)) {
          reportedEdges.add(edgeKey);
          cycles.push(cycle);
        }
      }
      return;
    }
    if (visited.has(node)) return;

    inStack.add(node);
    path.push(node);

    const deps = adjacency.get(node) || new Set();
    for (const dep of deps) {
      dfs(dep, path);
    }

    path.pop();
    inStack.delete(node);
    visited.add(node);
  }

  for (const file of files) {
    if (!visited.has(file)) {
      dfs(file, []);
    }
  }

  return cycles;
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
    for (const { importedName, sourceFile } of fileImports) {
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
