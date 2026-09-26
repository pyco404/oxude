/**
 * Types for the standalone page, so the suite can hold it to the real library.
 *
 * Declarations only: exit.mjs stays plain JavaScript that a browser can run
 * from a file:// URL with nothing installed, which is the entire point of it.
 */
export const PROGRAM_ID: string;
export const TOKEN_PROGRAM_ID: string;
export const SYSTEM_PROGRAM_ID: string;
export const ASSOCIATED_TOKEN_PROGRAM_ID: string;
export const DISCRIMINATORS: Record<"request_exit" | "claim_exit" | "close_exit", number[]>;

export function base58Encode(bytes: Uint8Array): string;
export function base58Decode(str: string): Uint8Array;
export function isOnCurve(bytes: Uint8Array): boolean;
export function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<[string, number]>;
export function uuidBytes(uuid: string): Uint8Array;
export function uuidFromBytes(bytes: Uint8Array | number[]): string;
export function associatedTokenAddress(owner: string, mint: string): Promise<string>;
export function compactU16(n: number): Uint8Array;

export const pdas: {
  config(): Promise<[string, number]>;
  exitConfig(): Promise<[string, number]>;
  vault(agentId: string): Promise<[string, number]>;
  owner(agentId: string): Promise<[string, number]>;
  exit(agentId: string): Promise<[string, number]>;
};

export type AccountMeta = { pubkey: string; signer: boolean; writable: boolean };
export type Instruction = { programId: string; keys: AccountMeta[]; data: Uint8Array };

export function requestExitIx(input: { owner: string; agentId: string; amount: number }): Promise<Instruction>;
export function claimExitIx(input: { owner: string; agentId: string; destination: string }): Promise<Instruction>;
export function closeExitIx(input: { owner: string; agentId: string }): Promise<Instruction>;
export function buildMessage(input: { payer: string; instructions: Instruction[]; recentBlockhash: string }): Uint8Array;

export function decodeExit(data: Uint8Array): {
  agentId: string;
  owner: string;
  amount: number;
  requestedSlot: number;
  unlockSlot: number;
  vaultAtRequest: number;
  claimedSlot: number;
  claimedAmount: number;
};
export function decodeAgentOwner(data: Uint8Array): { agentId: string; owner: string };
export function decodeConfig(data: Uint8Array): {
  admin: string;
  settler: string;
  mint: string;
  maxSettlement: number;
  rent: number;
  chipRate: number;
};
export function decodeTokenAmount(data: Uint8Array): number;
export function decodeExitConfig(data: Uint8Array): { slots: number };
