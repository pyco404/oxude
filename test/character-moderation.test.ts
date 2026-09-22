import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { moderate, nameShape, reservedWord, type TextCheck } from "../src/character/moderation.js";
import { bioWriter, textCheck } from "../src/character/model.js";

/** A client whose parse returns what the test says, and records what it was asked. */
function stub(parsed: unknown, stop_reason = "end_turn") {
  const asked: { model: string; system: string }[] = [];
  const client = {
    messages: {
      parse: async (params: { model: string; system: string }) => {
        asked.push(params);
        return { parsed_output: parsed, stop_reason, content: [] };
      },
    },
  } as unknown as Anthropic;
  return { client, asked };
}

describe("moderation", () => {
  it("stops a name that speaks for the platform, however it is spelled", () => {
    for (const name of ["Oxude Official", "0xude", "Adm1n", "the Moderator", "SUPPORT desk", "Staff Pick"]) {
      expect(reservedWord(name), name).not.toBeNull();
    }
    for (const name of ["Vessarin", "Ashvault", "Quiet Anvil", "Lanternfish"]) expect(reservedWord(name), name).toBeNull();
    expect(reservedWord("Administrator")).toMatch(/"administrator"/);
  });

  it("checks a name's shape before anything else", () => {
    expect(nameShape("x")).toMatch(/at least two/);
    expect(nameShape("x".repeat(33))).toMatch(/at most 32/);
    expect(nameShape("<b>Bold</b>")).toMatch(/markup/);
    expect(nameShape("Vessarin")).toBeNull();
  });

  it("asks the model for the rest, and says why when it refuses", async () => {
    const check: TextCheck = async (text) => (text === "Bad Name" ? { ok: false, reason: "can't use that name: it names a real person" } : { ok: true, reason: null });
    expect(await moderate("Good Name", "name", check)).toEqual({ ok: true, reason: null, checked: true });
    expect(await moderate("Bad Name", "name", check)).toEqual({ ok: false, reason: "can't use that name: it names a real person", checked: true });
  });

  it("never asks the model about what the local rules already stopped", async () => {
    let asked = 0;
    const check: TextCheck = async () => {
      asked++;
      return { ok: true, reason: null };
    };
    await moderate("Oxude Staff", "name", check);
    await moderate("x", "name", check);
    expect(asked).toBe(0);
  });

  it("lets a name through marked unchecked when the model can't be reached, rather than block a rental", async () => {
    const down: TextCheck = async () => {
      throw new Error("fetch failed");
    };
    expect(await moderate("Vessarin", "name", down)).toEqual({ ok: true, reason: null, checked: false });
    expect(await moderate("Vessarin", "name", null)).toEqual({ ok: true, reason: null, checked: false });
  });

  it("maps the model's verdict to a reason an owner can act on, on Haiku", async () => {
    const good = stub({ verdict: "ok", reason: "" });
    expect(await textCheck(good.client)("Vessarin", "name")).toEqual({ ok: true, reason: null });
    expect(good.asked[0]!.model).toBe("claude-haiku-4-5");
    const bad = stub({ verdict: "real_person", reason: "a head of state" });
    expect(await textCheck(bad.client)("Some Name", "name")).toEqual({ ok: false, reason: "can't use that name: it names or points at a real person" });
    await expect(textCheck(stub(null, "refusal").client)("x y", "name")).rejects.toThrow();
  });

  it("keeps a model bio only when it is a usable length", async () => {
    const input = { name: "Vessarin", epithet: "the Quiet Anvil", character: "porcelain mask", mood: "calm", play: "calls, raises strong hands" };
    expect(await bioWriter(stub({ bio: "  Vessarin never hurries and never bluffs; raise at her and she simply calls.  " }).client)(input)).toBe(
      "Vessarin never hurries and never bluffs; raise at her and she simply calls.",
    );
    expect(await bioWriter(stub({ bio: "Short." }).client)(input)).toBeNull();
    expect(await bioWriter(stub({ bio: "x".repeat(600) }).client)(input)).toBeNull();
    expect(await bioWriter(stub(null, "refusal").client)(input)).toBeNull();
  });
});
