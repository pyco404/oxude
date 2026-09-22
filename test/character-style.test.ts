import { describe, expect, it } from "vitest";
import { snapshotPreset } from "../src/db/runner.js";
import { styleOf } from "../src/character/style.js";
import { table } from "./helpers.js";

describe("style from a decision table", () => {
  it("reads the four presets as they play", () => {
    const [anchor, hammer, mirage, bully] = (["Anchor", "Hammer", "Mirage", "Bully"] as const).map((n) => styleOf(snapshotPreset(n)));
    expect(anchor).toMatchObject({ aggression: 0.4, bluff: 0 });
    expect(hammer).toMatchObject({ aggression: 0.6, bluff: 0 });
    expect(mirage).toMatchObject({ aggression: 0.4, bluff: 1 });
    expect(bully).toMatchObject({ aggression: 0.8, bluff: 0, backsDown: 0.6 });
    // Anchor and Hammer fold a weak hand once raised at; Mirage and Bully do not change.
    expect(anchor!.pressure).toBeLessThan(0);
    expect(mirage!.pressure).toBe(0);
  });

  it("calls raising everything aggression, not bluffing", () => {
    const maniac = table({}, "r r r r r");
    expect(styleOf(maniac)).toMatchObject({ aggression: 1, bluff: 0 });
  });

  it("sees a bluff in a brief's table however it is laid out", () => {
    // Raises its second-weakest hand and nothing in the middle: polarised, in two rows of four.
    const odd = table({ lead: "c r c c r", vsCall: "c r c c r" });
    expect(styleOf(odd).bluff).toBe(0.5);
  });

  it("reads pushing back and backing down under pressure", () => {
    const pusher = table({ leadUnderPressure: "r r r r r", vsCallUnderPressure: "r r r r r" });
    const rattled = table({ leadUnderPressure: "f f f c c", vsCallUnderPressure: "f f f c c", vsRaiseUnderPressure: "f f f f c" });
    expect(styleOf(pusher).pressure).toBe(1);
    expect(styleOf(rattled).pressure).toBe(-1);
    expect(styleOf(table({})).pressure).toBe(0);
  });
});
