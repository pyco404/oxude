import { agentIdFor } from "../src/agent-id.js";
import type { ChainPort } from "../src/chain/worker.js";
import type { ChainExit } from "../src/chain/settlement.js";
import type { SeedOpenVaultInput } from "../src/chain/seed-settlement.js";

/**
 * The settlement program as the outbox sees it, in memory.
 *
 * Lives outside any test file so more than one suite can use it: importing a
 * *.test.ts from another would run its describes a second time.
 */
export class FakeChain implements ChainPort {
  vaults = new Map<string, number>();
  settled = new Set<string>();
  calls: string[] = [];
  failNext: string | null = null;
  /** Agents whose vault has paid out its limit for this window: the program refuses, for now. */
  throttled = new Set<string>();
  /** Simulates a submission that landed but whose confirmation was lost. */
  landButThrow = false;

  async openVault({ agentId, owner, salt, amount }: SeedOpenVaultInput) {
    this.calls.push(`open ${agentId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (agentIdFor(owner, salt) !== agentId) throw new Error("Error Code: AgentIdMismatch");
    if (this.vaults.has(agentId)) throw new Error("vault already in use");
    this.vaults.set(agentId, amount);
    if (owner) this.owners.set(agentId, owner);
    if (this.landButThrow) throw new Error("timed out waiting for confirmation");
    return `sig-open-${agentId}`;
  }
  async settle(input: { matchId: string; fromAgent: string; toAgent: string; amount: number }) {
    this.calls.push(`settle ${input.matchId.slice(0, 4)}`);
    if (this.failNext) throw new Error(this.failNext);
    if (this.settled.has(input.matchId)) throw new Error("settlement already in use");
    if (this.throttled.has(input.fromAgent)) throw new Error("Error Code: OutflowLimit");
    const from = this.vaults.get(input.fromAgent);
    const to = this.vaults.get(input.toAgent);
    if (from === undefined || to === undefined) throw new Error("Error Code: AccountNotInitialized");
    if (from < input.amount) throw new Error("Error Code: InsufficientVault");
    this.vaults.set(input.fromAgent, from - input.amount);
    this.vaults.set(input.toAgent, to + input.amount);
    this.settled.add(input.matchId);
    if (this.landButThrow) throw new Error("timed out waiting for confirmation");
    return `sig-settle-${input.matchId}`;
  }
  async hasVault(agentId: string) {
    return this.vaults.has(agentId);
  }
  async isSettled(matchId: string) {
    return this.settled.has(matchId);
  }
  async settlementSignature(matchId: string) {
    return this.settled.has(matchId) ? `sig-settle-${matchId}` : null;
  }
  async vaultBalance(agentId: string) {
    return this.vaults.get(agentId) ?? null;
  }
  owners = new Map<string, string>();
  async ownerOf(agentId: string) {
    return this.owners.get(agentId) ?? null;
  }
  // Withdrawals are exercised in withdraw.test.ts with a fake that checks transactions.
  async submitWithdrawal(): Promise<string> {
    throw new Error("not used here");
  }
  async isWithdrawn() {
    return false;
  }
  /** Exits the chain knows about, as the deposit program would report them. */
  onChain = new Map<string, ChainExit>();
  async exitOf(agentId: string) {
    return this.onChain.get(agentId) ?? null;
  }
  async exits() {
    return [...this.onChain.values()];
  }
  /** The live exit window, which an admin can move under a running server. */
  window: number | null = 4_500;
  async exitWindow() {
    return this.window;
  }
  /** The owner asks to leave, as request_exit would. Moves nothing. */
  requestExit(agentId: string, amount: number, slot = 100, window = 4_500) {
    this.onChain.set(agentId, {
      agentId,
      owner: this.owners.get(agentId) ?? "owner",
      amount,
      requestedSlot: slot,
      unlockSlot: slot + window,
      vaultAtRequest: this.vaults.get(agentId) ?? 0,
      claimedSlot: 0,
      claimedAmount: 0,
    });
  }
  /**
   * An owner took money out of their own vault, as claim_exit would: the
   * smaller of what was asked and what is there. With no request on record,
   * one is made for `amount` first, so a test about the claim alone can skip it.
   */
  claimExit(agentId: string, amount: number, slot = 1_000) {
    if (!this.onChain.has(agentId) || this.onChain.get(agentId)!.claimedSlot !== 0) this.requestExit(agentId, amount, slot - 4_500);
    const exit = this.onChain.get(agentId)!;
    const held = this.vaults.get(agentId) ?? 0;
    const paid = Math.min(exit.amount, held);
    this.vaults.set(agentId, held - paid);
    this.onChain.set(agentId, { ...exit, claimedSlot: slot, claimedAmount: paid });
  }
  /** close_exit: a cancel before the claim, or clearing the record after one. */
  closeExit(agentId: string) {
    this.onChain.delete(agentId);
  }
  async blockHeightPassed() {
    return false;
  }
}
