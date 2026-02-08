#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { resolve } from "path";
import { analyzeProject } from "./cli/commands.js";
import type { AnalysisConfig } from "./types/index.js";

const program = new Command();

program
  .name("treeshake-check")
  .description(
    "Analyze JavaScript/TypeScript React applications for tree-shaking issues",
  )
  .version("1.0.2");

program
  .command("analyze")
  .description("Analyze a project for tree-shaking issues")
  .argument("[path]", "Path to the project directory", ".")
  .option(
    "-b, --bundler <type>",
    "Force bundler type (vite|webpack|rollup|esbuild)",
  )
  .option("-s, --stats <file>", "Path to bundle stats/metafile")
  .option("-o, --output <format>", "Output format (text|json)", "text")
  .option("-t, --threshold <bytes>", "Minimum size to report (bytes)", "0")
  .option("--no-suggestions", "Hide fix suggestions")
  .option("-i, --include <patterns...>", "Glob patterns to include")
  .option("-e, --exclude <patterns...>", "Glob patterns to exclude")
  .action(async (path: string, options: any) => {
    const projectPath = resolve(process.cwd(), path);

    const config: AnalysisConfig = {
      projectPath,
      bundler: options.bundler,
      statsFile: options.stats
        ? resolve(process.cwd(), options.stats)
        : undefined,
      outputFormat: options.output,
      threshold: parseInt(options.threshold, 10),
      showSuggestions: options.suggestions !== false,
      include: options.include,
      exclude: options.exclude,
    };

    const spinner = ora("Analyzing project for tree-shaking issues...").start();

    try {
      const report = await analyzeProject(config);
      spinner.stop();

      if (config.outputFormat === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printTextReport(report, config);
      }

      // Exit with error code if critical issues found
      if (report.summary.criticalCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      spinner.fail("Analysis failed");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

program
  .command("report")
  .description("Generate report from existing bundle stats file")
  .argument("<stats-file>", "Path to the bundle stats/metafile")
  .option(
    "-b, --bundler <type>",
    "Bundler type (vite|webpack|rollup|esbuild)",
    "webpack",
  )
  .option("-o, --output <format>", "Output format (text|json)", "text")
  .option("-t, --threshold <bytes>", "Minimum size to report (bytes)", "0")
  .action(async (statsFile: string, options: any) => {
    const config: AnalysisConfig = {
      projectPath: process.cwd(),
      bundler: options.bundler,
      statsFile: resolve(process.cwd(), statsFile),
      outputFormat: options.output,
      threshold: parseInt(options.threshold, 10),
      showSuggestions: true,
    };

    const spinner = ora("Analyzing bundle stats...").start();

    try {
      const report = await analyzeProject(config);
      spinner.stop();

      if (config.outputFormat === "json") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printTextReport(report, config);
      }
    } catch (error) {
      spinner.fail("Analysis failed");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

function printTextReport(report: any, config: AnalysisConfig): void {
  const { summary, issues } = report;

  console.log();
  console.log(chalk.bold.cyan("🔍 Tree-Shaking Analysis Report"));
  console.log(chalk.gray("━".repeat(50)));
  console.log();

  // Summary
  console.log(chalk.bold("Summary:"));
  console.log(`  📁 Project: ${chalk.white(summary.projectPath)}`);
  console.log(`  🔧 Bundler: ${chalk.white(summary.bundler)}`);
  console.log(`  📊 Files Analyzed: ${chalk.white(summary.analyzedFiles)}`);
  console.log();

  if (summary.totalIssues === 0) {
    console.log(chalk.green("✅ No tree-shaking issues found!"));
    return;
  }

  console.log(`  ⚠️  Issues Found: ${chalk.yellow(summary.totalIssues)}`);
  if (summary.criticalCount > 0) {
    console.log(`     ${chalk.red("●")} Critical: ${summary.criticalCount}`);
  }
  if (summary.highCount > 0) {
    console.log(`     ${chalk.yellow("●")} High: ${summary.highCount}`);
  }
  if (summary.mediumCount > 0) {
    console.log(`     ${chalk.blue("●")} Medium: ${summary.mediumCount}`);
  }
  if (summary.lowCount > 0) {
    console.log(`     ${chalk.gray("●")} Low: ${summary.lowCount}`);
  }
  console.log(
    `  📦 Potential Savings: ${chalk.green(formatBytes(summary.estimatedSavings))}`,
  );
  console.log();

  // Group issues by severity
  const criticalIssues = issues.filter((i: any) => i.severity === "critical");
  const highIssues = issues.filter((i: any) => i.severity === "high");
  const mediumIssues = issues.filter((i: any) => i.severity === "medium");
  const lowIssues = issues.filter((i: any) => i.severity === "low");

  if (criticalIssues.length > 0) {
    console.log(chalk.bold.red("CRITICAL ISSUES"));
    console.log(chalk.red("─".repeat(40)));
    printIssues(criticalIssues, config.showSuggestions);
  }

  if (highIssues.length > 0) {
    console.log(chalk.bold.yellow("HIGH PRIORITY ISSUES"));
    console.log(chalk.yellow("─".repeat(40)));
    printIssues(highIssues, config.showSuggestions);
  }

  if (mediumIssues.length > 0 && config.threshold === 0) {
    console.log(chalk.bold.blue("MEDIUM PRIORITY ISSUES"));
    console.log(chalk.blue("─".repeat(40)));
    printIssues(mediumIssues, config.showSuggestions);
  }

  if (lowIssues.length > 0 && config.threshold === 0) {
    console.log(chalk.bold.gray("LOW PRIORITY ISSUES"));
    console.log(chalk.gray("─".repeat(40)));
    printIssues(lowIssues, config.showSuggestions);
  }
}

function printIssues(issues: any[], showSuggestions: boolean): void {
  issues.forEach((issue, index) => {
    console.log();
    console.log(
      `${index + 1}. ${chalk.bold(getIssueTypeLabel(issue.type))}: ${chalk.cyan(issue.file)}`,
    );
    if (issue.line) {
      console.log(`   └─ Line: ${issue.line}`);
    }
    console.log(`   └─ Pattern: ${chalk.yellow(issue.pattern)}`);
    console.log(
      `   └─ Impact: ${chalk.red(formatBytes(issue.estimatedImpact))}`,
    );
    console.log(`   └─ ${issue.description}`);

    if (showSuggestions && issue.suggestion) {
      console.log(`   └─ ${chalk.green("Fix:")} ${issue.suggestion.title}`);
      if (issue.suggestion.code) {
        console.log(chalk.gray(`      ${issue.suggestion.code}`));
      }
    }
  });
  console.log();
}

function getIssueTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "barrel-file": "Barrel File",
    "side-effect": "Side Effect",
    "commonjs-module": "CommonJS Module",
    "unused-export": "Unused Export",
    "dynamic-import": "Dynamic Import",
    "circular-dependency": "Circular Dependency",
    "missing-sideeffects-config": "Missing sideEffects Config",
    "wildcard-reexport": "Wildcard Re-export",
  };
  return labels[type] || type;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

program.parse();
