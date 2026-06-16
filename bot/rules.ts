// Evaluates entry rules against an outcome's metric namespace.
import type { EntryConfig, Outcome, Rule } from "./types.ts";

function compare(actual: number, op: Rule["op"], target: number): boolean {
  switch (op) {
    case ">":
      return actual > target;
    case ">=":
      return actual >= target;
    case "<":
      return actual < target;
    case "<=":
      return actual <= target;
    case "==":
      return actual === target;
    case "abs>":
      return Math.abs(actual) > target;
    case "abs<":
      return Math.abs(actual) < target;
    default:
      return false;
  }
}

export interface RuleEval {
  rule: Rule;
  actual: number | undefined;
  pass: boolean;
}

export function evaluateRule(o: Outcome, rule: Rule): RuleEval {
  const actual = o.metrics[rule.metric];
  if (actual === undefined || !Number.isFinite(actual))
    return { rule, actual, pass: false };
  return { rule, actual, pass: compare(actual, rule.op, rule.value) };
}

export function passesEntry(
  o: Outcome,
  entry: EntryConfig,
): { ok: boolean; evals: RuleEval[]; reason: string } {
  if (o.price < entry.minPriceUsdt || o.price > entry.maxPriceUsdt)
    return {
      ok: false,
      evals: [],
      reason: `price ${o.price.toFixed(4)} outside [${entry.minPriceUsdt}, ${entry.maxPriceUsdt}]`,
    };
  const evals = entry.rules.map((r) => evaluateRule(o, r));
  const passCount = evals.filter((e) => e.pass).length;
  const ok = entry.combine === "all" ? passCount === evals.length : passCount > 0;
  const reason = evals
    .map(
      (e) =>
        `${e.rule.metric}${e.rule.op}${e.rule.value}(=${e.actual === undefined ? "n/a" : e.actual.toFixed(3)} ${e.pass ? "✓" : "✗"})`,
    )
    .join(" ");
  return { ok, evals, reason };
}
