import { describe, expect, it } from "vitest";
import { snapshotPreset } from "../src/db/runner.js";
import { PRESET_NAMES, type PresetName } from "../src/presets.js";
import { portrait } from "../src/character/portrait.js";
import { characterName, epithet, playNotes, templateBio } from "../src/character/identity.js";
import { reservedWord } from "../src/character/moderation.js";

const bioFor = (id: string, preset: PresetName) => {
  const t = snapshotPreset(preset);
  const p = portrait(id, t);
  return templateBio(id, characterName(id), p.features.type, t, p.style, p.expression);
};

describe("identity", () => {
  it("names an agent the same way every time, with an invented word", () => {
    expect(characterName("agent-1")).toBe(characterName("agent-1"));
    const names = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const name = characterName(`agent-${i}`, names);
      expect(name).toMatch(/^[A-Z][a-z]{3,10}$/);
      expect(reservedWord(name)).toBeNull();
      expect(name.toLowerCase()).not.toMatch(/(.)\1\1/);
      expect(names.has(name)).toBe(false);
      names.add(name);
    }
  });

  it("gives an epithet in the mood of how the agent plays", () => {
    const calm = epithet("e1", portrait("e1", snapshotPreset("Anchor")).expression);
    const sly = epithet("e1", portrait("e1", snapshotPreset("Mirage")).expression);
    expect(calm).toMatch(/^the (Quiet|Patient|Steady|Unhurried|Level|Stone-Faced|Slow) [A-Z][a-z]+$/);
    expect(sly).toMatch(/^the (Two-Faced|Smiling|Crooked|Velvet|Slippery|Double|Painted) [A-Z][a-z]+$/);
  });

  it("writes a bio from what the table actually does", () => {
    expect(bioFor("b1", "Mirage")).toMatch(/raises its weakest hands too, to steal the pot/);
    expect(bioFor("b1", "Anchor")).toMatch(/raises only a strong hand/);
    expect(bioFor("b1", "Anchor")).toMatch(/tightens up/);
    expect(bioFor("b1", "Bully")).toMatch(/raises almost any hand/);
    expect(bioFor("b1", "Bully")).toMatch(/backs down/);
    for (const preset of PRESET_NAMES) {
      const bio = bioFor(`b-${preset}`, preset);
      expect(bio.split(". ").length).toBe(3);
      expect(bio.length).toBeLessThan(300);
    }
  });

  it("describes the table in notes a bio writer can use, bluff included only when there is one", () => {
    const mirage = snapshotPreset("Mirage");
    expect(playNotes(mirage, portrait("n", mirage).style)).toHaveLength(4);
    const anchor = snapshotPreset("Anchor");
    expect(playNotes(anchor, portrait("n", anchor).style)).toHaveLength(3);
  });
});
