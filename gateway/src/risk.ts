// Risk levels for decisions, in one place. Risk only ever goes up: an unknown or
// missing value is treated as high.

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

/** A ceiling such as discord_approval_max_risk, where "none" allows nothing. */
export type RiskCeiling = "none" | Risk;

export const isRisk = (v: unknown): v is Risk => typeof v === "string" && (RISKS as readonly string[]).includes(v);

/** The value as a risk, or high if it isn't one. */
export const toRisk = (v: unknown): Risk => (isRisk(v) ? v : "high");

export const maxRisk = (a: Risk, b: Risk): Risk => (RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b);

/** True when `risk` is a known level no higher than `ceiling`. */
export function riskAtMost(risk: unknown, ceiling: RiskCeiling): boolean {
  if (!isRisk(risk) || ceiling === "none") return false;
  return RISKS.indexOf(risk) <= RISKS.indexOf(ceiling);
}
