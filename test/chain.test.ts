import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ChainClient, PROGRAM_ID, pdas } from "../src/chain/settlement.js";

// The settlement program on a local validator, loaded at genesis. Needs
// solana-test-validator on PATH and the program built (anchor build in chain/),
// so it runs only when CHAIN=1.
const RUN = process.env["CHAIN"] === "1";
const RPC_PORT = 28899 + Math.floor(Math.random() * 500);

let validator: ChildProcess | undefined;
let ledger: string;
let connection: Connection;
let admin: Keypair;
let settler: Keypair;
let chain: ChainClient;
const MAX = 60;

async function airdrop(to: Keypair, sol: number) {
  const sig = await connection.requestAirdrop(to.publicKey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

describe.skipIf(!RUN)("settlement program", () => {
  beforeAll(async () => {
    ledger = mkdtempSync(join(tmpdir(), "oxude-ledger-"));
    validator = spawn(
      "solana-test-validator",
      [
        "--reset", "--quiet", "--ledger", ledger,
        "--rpc-port", String(RPC_PORT), "--faucet-port", String(RPC_PORT + 1000),
        "--dynamic-port-range", `${RPC_PORT + 2000}-${RPC_PORT + 2100}`,
        "--bpf-program", PROGRAM_ID.toBase58(), "chain/target/deploy/oxude_settlement.so",
      ],
      { stdio: "ignore" },
    );
    connection = new Connection(`http://127.0.0.1:${RPC_PORT}`, "confirmed");
    for (let i = 0; i < 60; i++) {
      try {
        await connection.getVersion();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    admin = Keypair.generate();
    settler = Keypair.generate();
    await airdrop(admin, 5);
    await airdrop(settler, 5);
    await new ChainClient(connection, admin).initialize(settler.publicKey, MAX);
    chain = new ChainClient(connection, settler);
  }, 60_000);

  afterAll(() => {
    validator?.kill("SIGKILL");
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it("is configured with the settler, the mint and the limit", async () => {
    const config = await chain.config();
    expect(config.settler.toBase58()).toBe(settler.publicKey.toBase58());
    expect(config.admin.toBase58()).toBe(admin.publicKey.toBase58());
    expect(config.mint.toBase58()).toBe(pdas.mint().toBase58());
    expect(config.maxSettlement.toNumber()).toBe(MAX);
  });

  it("opens a vault funded with the starting balance", async () => {
    const agent = randomUUID();
    await chain.openVault(agent, 180);
    expect(await chain.vaultBalance(agent)).toBe(180);
    // A vault opens once.
    await expect(chain.openVault(agent, 180)).rejects.toThrow();
  });

  it("settles a match between vaults and records it once", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);
    const match = randomUUID();

    await chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 42 });
    expect(await chain.vaultBalance(a)).toBe(138);
    expect(await chain.vaultBalance(b)).toBe(222);
    expect(await chain.isSettled(match)).toBe(true);

    const record = await chain.program.account.settlement.fetch(pdas.settlement(match));
    expect(record.amount.toNumber()).toBe(42);

    // The same match cannot move money twice, even with a different amount.
    await expect(chain.settle({ matchId: match, fromAgent: a, toAgent: b, amount: 1 })).rejects.toThrow();
    expect(await chain.vaultBalance(a)).toBe(138);
  });

  it("refuses more than the per-match limit, even from the settler", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: MAX + 1 })).rejects.toThrow(
      /OverLimit|per-match limit/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });

  it("refuses a vault that cannot cover it, and a self-settlement", async () => {
    const [poor, rich] = [randomUUID(), randomUUID()];
    await chain.openVault(poor, 10);
    await chain.openVault(rich, 180);
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: poor, toAgent: rich, amount: 11 })).rejects.toThrow(
      /InsufficientVault|cannot cover/,
    );
    await expect(chain.settle({ matchId: randomUUID(), fromAgent: rich, toAgent: rich, amount: 5 })).rejects.toThrow();
  });

  it("refuses anyone but the settler", async () => {
    const intruder = Keypair.generate();
    await airdrop(intruder, 2);
    const rogue = new ChainClient(connection, intruder);
    const [a, b] = [randomUUID(), randomUUID()];
    await chain.openVault(a, 180);
    await chain.openVault(b, 180);

    await expect(rogue.openVault(randomUUID(), 1_000_000)).rejects.toThrow(/NotSettler|settler/);
    await expect(rogue.settle({ matchId: randomUUID(), fromAgent: a, toAgent: b, amount: 10 })).rejects.toThrow(
      /NotSettler|settler/,
    );
    expect(await chain.vaultBalance(a)).toBe(180);
  });
});
