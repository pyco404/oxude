/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/oxude_settlement.json`.
 */
export type OxudeSettlement = {
  "address": "HTs42VFpHS4XT9Cr8xH7cJEMgqPL9uuzZn6QHGwtvkdy",
  "metadata": {
    "name": "oxudeSettlement",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Oxude devnet settlement: game currency, agent vaults, match settlement records"
  },
  "instructions": [
    {
      "name": "claimExit",
      "docs": [
        "Pays out an exit whose window has passed. The owner signs; nobody else",
        "is needed, which is the whole point of it.",
        "",
        "Pays `min(requested, vault)`, because the window is allowed to have",
        "taken money out: a settlement that landed while this waited is exactly",
        "what the wait was for. It cannot overdraw, and it does not fail because",
        "the vault shrank.",
        "",
        "If the remainder would be unplayable dust, this takes the lot instead",
        "of refusing. Refusing would be the custodial answer - it assumes a",
        "server is standing by to work out a better number and ask again - and",
        "an exit that can fail on arithmetic the owner cannot see is not a",
        "guarantee. Taking everything is always the owner's own money and always",
        "leaves a valid vault."
      ],
      "discriminator": [
        109,
        115,
        53,
        37,
        198,
        221,
        203,
        41
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "agentOwner",
            "exit"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentOwner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "The owner's own token account for the game currency, and nobody else's."
          ],
          "writable": true
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "closeExit",
      "docs": [
        "Clears an exit and returns its rent to the owner.",
        "",
        "Before a claim this is a cancel, and needs no wait: changing your mind",
        "costs nobody anything.",
        "",
        "After a claim it waits one window, and that wait is",
        "load-bearing. A claimed exit is the only evidence on chain that the",
        "vault is legitimately smaller than the server's ledger. Erase it before",
        "the server has read it and the shortfall becomes indistinguishable from",
        "a drained vault: the reconciler alarms, correctly, and never stops. So",
        "the record outlives the claim by as long as the server had to settle in",
        "the first place."
      ],
      "discriminator": [
        239,
        55,
        234,
        254,
        49,
        69,
        52,
        60
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "exit"
          ]
        },
        {
          "name": "exitConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "deposit",
      "docs": [
        "Moves tokens from a wallet into an agent's vault. This is how every",
        "vault is funded: by its owner at rent time and whenever they top it up,",
        "and for a house agent by whoever runs the roster.",
        "",
        "The depositor signs and the tokens are their own. The program does not",
        "check that they are the agent's owner, and could not usefully: a vault",
        "is an ordinary token account, so a plain SPL transfer reaches it without",
        "coming through here at all. What this instruction adds is the event - a",
        "credit that names the agent and the wallet it came from, so the ledger",
        "can attribute it instead of finding a surplus it cannot explain.",
        "",
        "Depositing into someone else's agent is therefore allowed. It gives that",
        "agent money, which is nobody's loss but the depositor's."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "depositor",
          "docs": [
            "Whoever is paying. Signs for the transfer out of their own account."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "source",
          "docs": [
            "The depositor's own token account for the stake token, and nobody else's."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "docs": [
            "Seeded by the agent id, so the event cannot name one agent while the",
            "money goes to another."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initExitConfig",
      "docs": [
        "Turns exits on, with the window they wait.",
        "",
        "Its own account rather than a field on `Config`, and the reason is",
        "concrete: `Config` is already live on devnet at 137 bytes with no room",
        "spare, so growing it would need a realloc of an account that the",
        "migration instruction cannot itself deserialize. A separate singleton",
        "costs one more account read and leaves the deployed config untouched.",
        "",
        "It also means exits are off until an admin turns them on: `request_exit`",
        "needs this account, so a deployment that has not created it has no exit",
        "path at all. That is the right default for rolling this out."
      ],
      "discriminator": [
        198,
        230,
        207,
        227,
        176,
        216,
        90,
        82
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "exitConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "slots",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup: the config, pointed at the stake token.",
        "",
        "The mint is passed in rather than created here, and it is refused unless",
        "its mint authority is already `None`. That is the whole of the supply",
        "guarantee: this program holds no authority to mint, and neither does",
        "anyone else, so the currency cannot be inflated after this call."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "The stake token: an ordinary mint made outside this program, whose mint",
            "authority has already been given up. Checked in `initialize`."
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "settler",
          "type": "pubkey"
        },
        {
          "name": "maxSettlement",
          "type": "u64"
        },
        {
          "name": "rent",
          "type": "u64"
        },
        {
          "name": "chipRate",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openOwnedVault",
      "docs": [
        "Opens a player's agent's empty vault and records its owner, together.",
        "The agent id must be the hash of that owner's key and the salt, so this",
        "is the only owner the agent can ever have: whoever sends it, the settler",
        "included, can't record another, and the record can't be created twice.",
        "",
        "The money arrives separately, through `deposit`, which the renting",
        "transaction carries in the same instruction list."
      ],
      "discriminator": [
        3,
        231,
        93,
        105,
        192,
        1,
        220,
        88
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "agentOwner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "salt",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "owner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "openVault",
      "docs": [
        "Opens a house agent's empty vault. It is funded by `deposit`, like any",
        "other, because there is nothing here that can create currency."
      ],
      "discriminator": [
        181,
        248,
        228,
        67,
        6,
        175,
        37,
        167
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "salt",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        }
      ]
    },
    {
      "name": "payRent",
      "docs": [
        "Pays for a rental by burning the fee out of the renter's own tokens.",
        "",
        "Burned, not collected: the fee leaves the supply rather than moving to",
        "the platform, so renting takes tokens off the market instead of funding",
        "a wallet. The record makes a rental id unrepeatable, so a retried",
        "transaction cannot charge twice.",
        "",
        "At rent time this is the first of three instructions the owner signs in",
        "one transaction - the fee, the vault, the deposit - so a paid fee can",
        "never be left behind by a rental that did not happen."
      ],
      "discriminator": [
        69,
        155,
        112,
        183,
        178,
        234,
        94,
        100
      ],
      "accounts": [
        {
          "name": "renter",
          "docs": [
            "Pays the fee out of their own tokens, and signs for the burn."
          ],
          "signer": true
        },
        {
          "name": "settler",
          "docs": [
            "Co-signs and pays this record's account rent, as it does for every other",
            "account this program opens."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "source",
          "docs": [
            "The renter's own token account, and nobody else's."
          ],
          "writable": true
        },
        {
          "name": "rental",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "rentalId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "rentalId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "requestExit",
      "docs": [
        "Starts an exit that this server does not co-sign.",
        "",
        "The owner alone signs, and alone pays. Nothing moves here: this records",
        "the intent and starts the clock, and `claim_exit` pays out once",
        "the configured window has passed. The gap is the point - it is the",
        "server's chance to settle every match this agent has already played,",
        "before money that may already be owed elsewhere leaves the vault.",
        "",
        "One exit per agent, because the PDA is seeded by the agent alone. A",
        "second request while one is live fails on the account already existing,",
        "which is what we want: an owner closes the first or claims it."
      ],
      "discriminator": [
        121,
        186,
        203,
        74,
        138,
        218,
        135,
        151
      ],
      "accounts": [
        {
          "name": "owner",
          "docs": [
            "Signs and pays. No settler here - that is the point of this path."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "agentOwner"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "exitConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentOwner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "exit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setChipRate",
      "docs": [
        "Sets the season's rate: how many base units one chip is worth.",
        "",
        "The admin supplies a number computed off chain from a published",
        "time-weighted average price, and the program holds it to three bounds it",
        "can check for itself: it may not move by more than half either way, it",
        "may not exceed `MAX_CHIP_RATE`, and it may not move again for",
        "`MIN_RATE_INTERVAL_SLOTS`. Those bound what a wrong or dishonest reading",
        "can do; they do not make one acceptable. An on-chain oracle can take the",
        "admin's place later without changing any of the three.",
        "",
        "`max_settlement` is a chip figure held in base units, so it is rescaled",
        "here rather than left to mean a different number of chips than it did",
        "yesterday - which also means a falling rate can never strand it above",
        "the ceiling and make the next change impossible."
      ],
      "discriminator": [
        118,
        150,
        126,
        120,
        34,
        136,
        51,
        167
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin recorded on the config, and nobody else."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "chipRate",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setExitWindow",
      "docs": [
        "Moves the exit window.",
        "",
        "Lengthening is free: a longer window only means more time to settle and",
        "a longer wait for the owner, both safe. Shortening is capped at half",
        "per step, the same shape as the chip rate's band, so that walking a",
        "live deployment down to nothing takes many transactions rather than",
        "one, and every one of them is on chain."
      ],
      "discriminator": [
        78,
        210,
        217,
        160,
        43,
        141,
        57,
        161
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "exitConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "slots",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMaxSettlement",
      "docs": [
        "Raises or lowers the most a single settlement can move. The admin",
        "recorded at initialize is the only key that can call it - not the",
        "settler, whose reach this value is there to limit in the first place.",
        "It exists so a band with bigger stakes can be priced in without another",
        "program upgrade, and it is bounded by `MAX_SETTLEMENT_CEILING_CHIPS` at",
        "the season's rate, so that a stolen admin key cannot turn the",
        "per-settlement guard off altogether."
      ],
      "discriminator": [
        31,
        159,
        143,
        234,
        236,
        242,
        90,
        117
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin recorded on the config, and nobody else."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxSettlement",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setRent",
      "docs": [
        "Sets what renting an agent costs, in base units. The admin recorded at",
        "initialize is the only key that can call it.",
        "",
        "On mainnet a season's rent is a fixed value in dollars converted at that",
        "season's rate, so this is called once per boundary, in the same",
        "transaction as the rate it was computed from.",
        "",
        "Nobody can be overcharged by a change landing at the wrong moment: the",
        "amount is an argument to `pay_rent`, so a player whose price moved while",
        "they were signing gets a failed transaction, not a bigger bill."
      ],
      "discriminator": [
        25,
        182,
        51,
        145,
        96,
        33,
        58,
        115
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin recorded on the config, and nobody else."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "rent",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setSettler",
      "docs": [
        "Points the config at a new settler key. The admin recorded at initialize",
        "is the only key that can call it.",
        "",
        "Without this a compromised settler could only be answered by upgrading",
        "the program, which is slow at exactly the moment speed matters. It",
        "refuses the key already in place, so a call that would change nothing",
        "fails loudly rather than looking like a rotation that happened. It also",
        "refuses the admin's own key: one key holding both roles would undo the",
        "separation every other check here depends on."
      ],
      "discriminator": [
        18,
        138,
        23,
        84,
        226,
        204,
        94,
        86
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "The admin recorded on the config, and nobody else."
          ],
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "settler",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settle",
      "docs": [
        "Moves a match's settled net from the loser's vault to the winner's, and",
        "records it. The amount was decided and validated off chain; this checks",
        "the bounds again and refuses to settle the same match twice."
      ],
      "discriminator": [
        175,
        42,
        185,
        87,
        144,
        131,
        102,
        212
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "fromVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "fromAgent"
              }
            ]
          }
        },
        {
          "name": "toVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "toAgent"
              }
            ]
          }
        },
        {
          "name": "outflow",
          "docs": [
            "The paying vault's outflow window, made the first time it pays."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "fromAgent"
              }
            ]
          }
        },
        {
          "name": "settlement",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  109,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "matchId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "matchId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "fromAgent",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "toAgent",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Moves tokens from an agent's vault to its owner. The owner must sign,",
        "and must be the owner recorded on chain; the settler co-signs to say",
        "nothing is in flight. `remaining` is what the ledger says the vault",
        "holds afterwards: if the vault disagrees, a settlement hasn't landed yet",
        "and this refuses. The vault is left empty or playable, never between."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "settler",
          "docs": [
            "Co-signs to say nothing is in flight, and pays the fees and rent."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "owner",
          "docs": [
            "Must be the owner recorded on chain for this agent."
          ],
          "signer": true,
          "relations": [
            "agentOwner"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "agentOwner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "agentId"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "The owner's own token account for the game currency, and nobody else's."
          ],
          "writable": true
        },
        {
          "name": "withdrawal",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "withdrawalId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "withdrawalId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "agentId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "remaining",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agentOwner",
      "discriminator": [
        190,
        101,
        239,
        64,
        153,
        105,
        28,
        196
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "exit",
      "discriminator": [
        25,
        25,
        160,
        223,
        53,
        155,
        170,
        162
      ]
    },
    {
      "name": "exitConfig",
      "discriminator": [
        85,
        178,
        65,
        30,
        75,
        105,
        80,
        59
      ]
    },
    {
      "name": "outflow",
      "discriminator": [
        243,
        63,
        238,
        64,
        255,
        74,
        205,
        145
      ]
    },
    {
      "name": "rental",
      "discriminator": [
        121,
        83,
        229,
        235,
        73,
        50,
        143,
        184
      ]
    },
    {
      "name": "settlement",
      "discriminator": [
        55,
        11,
        219,
        33,
        36,
        136,
        40,
        182
      ]
    },
    {
      "name": "withdrawal",
      "discriminator": [
        10,
        45,
        211,
        182,
        129,
        235,
        90,
        82
      ]
    }
  ],
  "events": [
    {
      "name": "chipRateChanged",
      "discriminator": [
        10,
        73,
        213,
        147,
        97,
        222,
        148,
        129
      ]
    },
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "exitClaimed",
      "discriminator": [
        251,
        154,
        235,
        216,
        216,
        190,
        30,
        25
      ]
    },
    {
      "name": "exitRequested",
      "discriminator": [
        92,
        125,
        6,
        23,
        233,
        196,
        149,
        70
      ]
    },
    {
      "name": "exitWindowChanged",
      "discriminator": [
        199,
        9,
        117,
        235,
        250,
        174,
        23,
        156
      ]
    },
    {
      "name": "maxSettlementChanged",
      "discriminator": [
        29,
        218,
        12,
        51,
        181,
        238,
        14,
        95
      ]
    },
    {
      "name": "rentChanged",
      "discriminator": [
        128,
        187,
        190,
        107,
        49,
        218,
        246,
        239
      ]
    },
    {
      "name": "rentPaid",
      "discriminator": [
        140,
        29,
        172,
        69,
        152,
        38,
        73,
        241
      ]
    },
    {
      "name": "settled",
      "discriminator": [
        232,
        210,
        40,
        17,
        142,
        124,
        145,
        238
      ]
    },
    {
      "name": "settlerChanged",
      "discriminator": [
        33,
        54,
        1,
        21,
        216,
        157,
        170,
        61
      ]
    },
    {
      "name": "vaultOpened",
      "discriminator": [
        198,
        250,
        195,
        25,
        26,
        107,
        197,
        16
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notSettler",
      "msg": "Only the configured settler can do this"
    },
    {
      "code": 6001,
      "name": "notAdmin",
      "msg": "Only the configured admin can do this"
    },
    {
      "code": 6002,
      "name": "invalidSettler",
      "msg": "The new settler must differ from the current settler and the admin, and cannot be the default key"
    },
    {
      "code": 6003,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6004,
      "name": "overLimit",
      "msg": "Settlement exceeds the per-match limit"
    },
    {
      "code": 6005,
      "name": "sameAgent",
      "msg": "A match cannot settle an agent against itself"
    },
    {
      "code": 6006,
      "name": "insufficientVault",
      "msg": "The paying vault cannot cover this settlement"
    },
    {
      "code": 6007,
      "name": "invalidLimit",
      "msg": "Limit must be greater than zero"
    },
    {
      "code": 6008,
      "name": "notOwner",
      "msg": "Only the agent's recorded owner can withdraw"
    },
    {
      "code": 6009,
      "name": "notOwnersAccount",
      "msg": "Withdrawals go only to the owner's own token account"
    },
    {
      "code": 6010,
      "name": "notDepositorsAccount",
      "msg": "A deposit comes only from the depositor's own token account"
    },
    {
      "code": 6011,
      "name": "wrongRent",
      "msg": "The rent paid is not the price the config carries"
    },
    {
      "code": 6012,
      "name": "notRentersAccount",
      "msg": "Rent is paid only from the renter's own token account"
    },
    {
      "code": 6013,
      "name": "wrongStakeDecimals",
      "msg": "The stake token does not have the expected number of decimals"
    },
    {
      "code": 6014,
      "name": "rateOverflow",
      "msg": "A chip limit does not fit in base units at this rate"
    },
    {
      "code": 6015,
      "name": "rateCeiling",
      "msg": "One chip cannot cost more than the ceiling on tokens per chip"
    },
    {
      "code": 6016,
      "name": "rateMoveTooBig",
      "msg": "The chip rate cannot move by more than half in one step"
    },
    {
      "code": 6017,
      "name": "rateTooSoon",
      "msg": "The chip rate has not stood long enough to move again"
    },
    {
      "code": 6018,
      "name": "ledgerMismatch",
      "msg": "The vault doesn't match the ledger: a settlement is still in flight"
    },
    {
      "code": 6019,
      "name": "unplayable",
      "msg": "A withdrawal must leave the vault empty or with at least the minimum stake"
    },
    {
      "code": 6020,
      "name": "agentIdMismatch",
      "msg": "The agent id isn't the hash of this owner and salt"
    },
    {
      "code": 6021,
      "name": "outflowLimit",
      "msg": "This vault has paid out all it can in this window"
    },
    {
      "code": 6022,
      "name": "mintableStakeToken",
      "msg": "The stake token still has a mint authority: its supply is not fixed"
    },
    {
      "code": 6023,
      "name": "exitLocked",
      "msg": "This exit's window has not passed yet"
    },
    {
      "code": 6024,
      "name": "exitAlreadyClaimed",
      "msg": "This exit has already been claimed"
    },
    {
      "code": 6025,
      "name": "exitEvidenceNeeded",
      "msg": "A claimed exit stays on chain a while, so the ledger can catch up before the record goes"
    },
    {
      "code": 6026,
      "name": "exitWindowTooShort",
      "msg": "The exit window cannot be shorter than the program's floor"
    },
    {
      "code": 6027,
      "name": "exitWindowShrinkTooFast",
      "msg": "The exit window cannot be more than halved in one step"
    }
  ],
  "types": [
    {
      "name": "agentOwner",
      "docs": [
        "One per agent with an owner: who may withdraw from its vault."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "chipRateChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previous",
            "type": "u64"
          },
          {
            "name": "chipRate",
            "type": "u64"
          },
          {
            "name": "maxSettlement",
            "docs": [
              "Rescaled with the rate, so it still means the same number of chips."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "settler",
            "docs": [
              "The only key that can open vaults and settle."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "maxSettlement",
            "docs": [
              "The most a single settlement can move."
            ],
            "type": "u64"
          },
          {
            "name": "rent",
            "docs": [
              "What renting an agent costs, in base units. Burned, not collected."
            ],
            "type": "u64"
          },
          {
            "name": "chipRate",
            "docs": [
              "Base units in one chip, for this season. Every chip-denominated limit",
              "here is converted through it."
            ],
            "type": "u64"
          },
          {
            "name": "chipRateSlot",
            "docs": [
              "The slot the rate last moved at; 0 until it first does."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "exit",
      "docs": [
        "A live or spent exit, one per agent.",
        "",
        "Seeded by the agent alone - deliberately not by an id the owner picks -",
        "so that the server can find any agent's exit at a deterministic address",
        "without having been told anything. Everything downstream depends on that:",
        "an exit the server cannot find is an exit it cannot ingest, and a",
        "shortfall it cannot explain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "What the owner asked for. The claim pays at most this, and at most what",
              "the vault still holds."
            ],
            "type": "u64"
          },
          {
            "name": "requestedSlot",
            "type": "u64"
          },
          {
            "name": "unlockSlot",
            "docs": [
              "Not before this slot may it be claimed."
            ],
            "type": "u64"
          },
          {
            "name": "vaultAtRequest",
            "docs": [
              "What the vault held when this was requested, for the server to compare."
            ],
            "type": "u64"
          },
          {
            "name": "claimedSlot",
            "docs": [
              "0 until claimed. Non-zero is what tells the reconciler that a smaller",
              "vault is explained rather than drained."
            ],
            "type": "u64"
          },
          {
            "name": "claimedAmount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "exitClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remaining",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "exitConfig",
      "docs": [
        "The live exit window, in slots. One per deployment."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "slots",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "exitRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "unlockSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "exitWindowChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previous",
            "type": "u64"
          },
          {
            "name": "slots",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "maxSettlementChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previous",
            "type": "u64"
          },
          {
            "name": "maxSettlement",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "outflow",
      "docs": [
        "One per agent that has paid out through a settlement: its current window."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "windowStart",
            "type": "u64"
          },
          {
            "name": "spent",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "rentChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previous",
            "type": "u64"
          },
          {
            "name": "rent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rentPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rentalId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "renter",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rental",
      "docs": [
        "One per rental paid for: its existence is what stops a fee being charged",
        "twice for the same rental."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rentalId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "renter",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "settled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "matchId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "fromAgent",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "toAgent",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settlement",
      "docs": [
        "One per match: its existence is what stops a match settling twice."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "matchId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "fromAgent",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "toAgent",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "settlerChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previous",
            "type": "pubkey"
          },
          {
            "name": "settler",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "vaultOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "docs": [
              "None for a house agent."
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "withdrawal",
      "docs": [
        "One per withdrawal: its existence is what stops a withdrawal paying twice."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "withdrawalId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remaining",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "withdrawalId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "agentId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remaining",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
