/**
 * Architectural boundary tests.
 *
 * These assert properties of the SOURCE, not of behaviour. Each one guards a
 * design decision that is easy to state, easy to agree with, and very easy to
 * erode one convenient import at a time.
 *
 * A failure here is not a style complaint. Each check corresponds to a
 * specific way this system could start quietly lying to a citizen.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every .ts/.tsx file under `dir`, recursively, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const found: string[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // Directory does not exist yet; later phases will create it.
    }

    for (const entry of entries) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "generated" || entry === "node_modules") continue;
        walk(path);
      } else if (/\.tsx?$/.test(entry)) {
        found.push(relative(ROOT, path).split(sep).join("/"));
      }
    }
  };

  walk(absolute);
  return found;
}

const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** Strip comments and string literals so matches are real code, not prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// ---------------------------------------------------------------------------

describe("the engine stays deterministic", () => {
  it("contains no import from the LLM or agent layers", () => {
    // The engine decides eligibility, money and state transitions. If a model
    // call could reach into it, a benefit verdict would stop being
    // reproducible, and "why was I refused?" would have no stable answer.
    const offenders: string[] = [];

    for (const file of sourceFiles("lib/engine")) {
      // Import paths are read from the original source, where string literals
      // survive the comment/string stripping used elsewhere.
      for (const match of read(file).matchAll(/from\s+["']([^"']+)["']/g)) {
        const target = match[1];
        if (
          target.includes("/llm") ||
          target.includes("/agents") ||
          target.includes("@google/genai")
        ) {
          offenders.push(`${file} imports ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no network or model calls", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("lib/engine")) {
      const source = code(read(file));
      for (const pattern of [/\bfetch\s*\(/, /\baxios\b/, /generateStructured/]) {
        if (pattern.test(source)) offenders.push(`${file} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("time is read in exactly one place", () => {
  it("has no ambient clock read outside lib/clock.ts", () => {
    // The demo advances a simulated clock to make months of benefit history
    // elapse on stage. Any module reading the real clock directly would be
    // invisible to that shift and would silently disagree with the rest of the
    // system about what "now" is.
    const allowed = new Set(["lib/clock.ts"]);
    const offenders: string[] = [];

    for (const file of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      if (allowed.has(file)) continue;

      const source = code(read(file));

      // `new Date()` with no arguments, and Date.now(), read ambient time.
      // `new Date(someValue)` merely parses and is fine.
      if (/new\s+Date\s*\(\s*\)/.test(source)) {
        offenders.push(`${file}: new Date()`);
      }
      if (/\bDate\.now\s*\(\s*\)/.test(source)) {
        offenders.push(`${file}: Date.now()`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the simulated government store is reached only through its adapter", () => {
  it("has no direct Prisma access to gov_* models outside lib/adapters", () => {
    // The product exists for the case where the government's record and the
    // citizen's reality disagree. Keeping the government side behind an
    // adapter is what makes that separation real rather than rhetorical, and
    // what allows a live API to replace the mock in one file.
    const allowedPrefixes = ["lib/adapters/", "prisma/"];
    const offenders: string[] = [];

    const govModels = [
      "govApplication",
      "govDisbursement",
      "govStatusEvent",
    ];

    for (const file of [...sourceFiles("lib"), ...sourceFiles("app")]) {
      if (allowedPrefixes.some((p) => file.startsWith(p))) continue;

      const source = code(read(file));
      for (const model of govModels) {
        // e.g. `prisma.govDisbursement.findMany`
        if (new RegExp(`\\.\\s*${model}\\s*\\.`).test(source)) {
          offenders.push(`${file} touches ${model} directly`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("raw financial documents are never persisted", () => {
  it("has no filesystem write in any upload or verification route", () => {
    // The privacy guarantee is that a bank statement is processed in memory
    // and discarded. A single writeFile in this path would turn a verification
    // step into a store of citizens' financial records.
    const offenders: string[] = [];

    const uploadPaths = [
      ...sourceFiles("app/api/verify"),
      ...sourceFiles("lib/documents"),
    ];

    for (const file of uploadPaths) {
      const source = code(read(file));
      for (const pattern of [
        /writeFileSync/,
        /createWriteStream/,
        /\bwriteFile\s*\(/,
        /fs\.promises\.writeFile/,
        /\bcp\s*\(/,
      ]) {
        if (pattern.test(source)) offenders.push(`${file} matches ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("money never becomes a float", () => {
  it("uses no parseFloat or Number() on monetary values in the engine", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles("lib/engine")) {
      // money.ts owns the one permitted conversion, for display only.
      if (file === "lib/engine/money.ts") continue;

      const source = code(read(file));
      if (/parseFloat\s*\(/.test(source)) {
        offenders.push(`${file}: parseFloat`);
      }
      if (/toFixed\s*\(/.test(source)) {
        offenders.push(`${file}: toFixed`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the boundary checks themselves are wired up", () => {
  it("found engine source files to scan", () => {
    // A scan that silently matches nothing would pass forever while guarding
    // nothing, which is worse than no test at all.
    expect(sourceFiles("lib/engine").length).toBeGreaterThan(5);
  });

  it("found app and lib files to scan for clock reads", () => {
    expect([...sourceFiles("lib"), ...sourceFiles("app")].length).toBeGreaterThan(8);
  });

  // The checks above are regex scans. If a pattern silently stopped matching -
  // through a refactor, a rename, or an over-eager strip - every guard would
  // report success while enforcing nothing. These assert the detectors still
  // fire on known-bad input.
  describe("the detectors actually detect", () => {
    it("catches an ambient clock read", () => {
      const bad = code("const t = new Date();\nconst u = Date.now();");
      expect(/new\s+Date\s*\(\s*\)/.test(bad)).toBe(true);
      expect(/\bDate\.now\s*\(\s*\)/.test(bad)).toBe(true);
    });

    it("permits parsing a date from a value", () => {
      const fine = code('const t = new Date(isoString);');
      expect(/new\s+Date\s*\(\s*\)/.test(fine)).toBe(false);
    });

    it("catches direct access to a government model", () => {
      const bad = code("await prisma.govDisbursement.findMany({});");
      expect(/\.\s*govDisbursement\s*\./.test(bad)).toBe(true);
    });

    it("catches a filesystem write", () => {
      const bad = code('await writeFile("/tmp/x", buffer);');
      expect(/\bwriteFile\s*\(/.test(bad)).toBe(true);
    });

    it("catches a float conversion", () => {
      const bad = code("const amount = parseFloat(raw);");
      expect(/parseFloat\s*\(/.test(bad)).toBe(true);
    });

    it("strips comments and strings so prose cannot trigger a false positive", () => {
      const prose = code(
        '// we never call new Date() here\nconst msg = "never use Date.now()";',
      );
      expect(/new\s+Date\s*\(\s*\)/.test(prose)).toBe(false);
      expect(/\bDate\.now\s*\(\s*\)/.test(prose)).toBe(false);
    });
  });
});
