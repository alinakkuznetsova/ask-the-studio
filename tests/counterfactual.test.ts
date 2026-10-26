import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settings } from "../src/config.js";

// the counterfactual eval needs an api key, but its edits can be checked
// without one: every find string must still exist in the knowledge base,
// or the case would silently test nothing
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "../evals/counterfactual.json"), "utf8")) as {
  cases: { id: string; edits: { file: string; find: string }[] }[];
};

describe("counterfactual cases", () => {
  for (const c of spec.cases) {
    it(`${c.id} edits text that exists`, () => {
      for (const e of c.edits) {
        const text = fs.readFileSync(path.join(settings.kbDir, e.file), "utf8");
        expect(text.includes(e.find), `${e.file}: ${e.find}`).toBe(true);
      }
    });
  }
});
