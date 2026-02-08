// ============================================================================
// Core Types
// ============================================================================

export type BundlerType = "vite" | "webpack" | "rollup" | "esbuild" | "unknown";

export type IssueSeverity = "critical" | "high" | "medium" | "low";

export type IssueType =
  | "barrel-file"
  | "side-effect"
  | "commonjs-module"
  | "unused-export"
  | "dynamic-import"
  | "circular-dependency"
  | "missing-sideeffects-config"
  | "wildcard-reexport";

export interface AnalysisConfig {
  projectPath: string;
  bundler?: BundlerType;
  statsFile?: string;
  outputFormat: "text" | "json";
  threshold: number;
  showSuggestions: boolean;
  include?: string[];
  exclude?: string[];
}

// ============================================================================
// Issue Types
// ============================================================================

export interface Suggestion {
  title: string;
  description: string;
  code?: string;
}

export interface TreeShakingIssue {
  type: IssueType;
  severity: IssueSeverity;
  file: string;
  line?: number;
  column?: number;
  pattern: string;
  description: string;
  estimatedImpact: number; // bytes
  suggestion?: Suggestion;
}

// ============================================================================
// Module Analysis Types
// ============================================================================

export interface ModuleExport {
  name: string;
  type: "named" | "default" | "namespace" | "reexport";
  line: number;
  isUsed: boolean;
  source?: string; // for re-exports
}

export interface ModuleImport {
  name: string;
  type: "named" | "default" | "namespace" | "dynamic";
  source: string;
  line: number;
}

export interface ModuleInfo {
  filePath: string;
  moduleType: "esm" | "cjs" | "mixed";
  exports: ModuleExport[];
  imports: ModuleImport[];
  hasSideEffects: boolean;
  sideEffectReasons: string[];
  isBarrelFile: boolean;
  size: number;
}

// ============================================================================
// Bundle Analysis Types
// ============================================================================

export interface BundleModule {
  id: string;
  name: string;
  size: number;
  parsedSize?: number;
  gzipSize?: number;
  isEntry: boolean;
  imports: string[];
  importedBy: string[];
}

export interface BundleChunk {
  name: string;
  size: number;
  modules: BundleModule[];
  isEntry: boolean;
}

export interface BundleAnalysis {
  bundler: BundlerType;
  totalSize: number;
  chunks: BundleChunk[];
  modules: Map<string, BundleModule>;
}

// ============================================================================
// Report Types
// ============================================================================

export interface AnalysisSummary {
  projectPath: string;
  bundler: BundlerType;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  estimatedSavings: number;
  bundleSize?: number;
  analyzedFiles: number;
  timestamp: string;
}

export interface AnalysisReport {
  summary: AnalysisSummary;
  issues: TreeShakingIssue[];
}

// ============================================================================
// Parser Types
// ============================================================================

export interface ParsedFile {
  path: string;
  content: string;
  ast: any; // acorn AST
}

// ============================================================================
// Bundler Stats Types
// ============================================================================

// Webpack stats.json structure (simplified)
export interface WebpackStats {
  assets: Array<{
    name: string;
    size: number;
  }>;
  modules: Array<{
    id: string | number;
    name: string;
    size: number;
    reasons: Array<{
      moduleId: string | number;
      type: string;
    }>;
  }>;
  chunks: Array<{
    id: string | number;
    names: string[];
    size: number;
    modules: Array<{
      name: string;
      size: number;
    }>;
  }>;
}

// esbuild metafile structure
export interface EsbuildMetafile {
  inputs: Record<
    string,
    {
      bytes: number;
      imports: Array<{
        path: string;
        kind: string;
      }>;
    }
  >;
  outputs: Record<
    string,
    {
      bytes: number;
      inputs: Record<
        string,
        {
          bytesInOutput: number;
        }
      >;
      imports: Array<{
        path: string;
        kind: string;
      }>;
      exports: string[];
      entryPoint?: string;
    }
  >;
}

// Rollup/Vite bundle info
export interface RollupBundleInfo {
  fileName: string;
  code: string;
  map?: any;
  modules: Record<
    string,
    {
      code: string;
      originalLength: number;
      renderedLength: number;
    }
  >;
}
