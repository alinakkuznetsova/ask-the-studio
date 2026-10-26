import { describe, expect, it } from "vitest";
import { agreement } from "../evals/agreement.js";

describe("judge agreement", () => {
  it("is perfect when the raters always match", () => {
    const a = agreement([[true, true], [false, false], [true, true], [false, false]]);
    expect(a.agreement).toBe(1);
    expect(a.kappa).toBe(1);
  });

  it("corrects for chance agreement", () => {
    // 80% raw agreement, but both raters say yes 80% of the time
    const pairs: [boolean, boolean][] = [
      ...Array(7).fill([true, true]),
      [true, false],
      [false, true],
      [false, false],
    ];
    const a = agreement(pairs);
    expect(a.agreement).toBeCloseTo(0.8);
    expect(a.kappa).toBeCloseTo(0.375);
    expect(a.judgeLenient).toBe(1);
    expect(a.judgeStrict).toBe(1);
  });

  it("has no kappa when both raters only ever say yes", () => {
    expect(agreement([[true, true], [true, true]]).kappa).toBeNull();
  });
});
