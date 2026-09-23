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
      "name": "setMaxSettlement",
      "docs": [
        "Raises or lowers the most a single settlement can move. The admin",
        "recorded at initialize is the only key that can call it - not the",
        "settler, whose reach this value is there to limit in the first place.",
        "It exists so a band with bigger stakes can be priced in without another",
        "program upgrade, and it is bounded by `MAX_SETTLEMENT_CEILING` so that a",
        "stolen admin key cannot turn the per-settlement guard off altogether."
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
      "name": "ledgerMismatch",
      "msg": "The vault doesn't match the ledger: a settlement is still in flight"
    },
    {
      "code": 6012,
      "name": "unplayable",
      "msg": "A withdrawal must leave the vault empty or with at least the minimum stake"
    },
    {
      "code": 6013,
      "name": "agentIdMismatch",
      "msg": "The agent id isn't the hash of this owner and salt"
    },
    {
      "code": 6014,
      "name": "outflowLimit",
      "msg": "This vault has paid out all it can in this window"
    },
    {
      "code": 6015,
      "name": "mintableStakeToken",
      "msg": "The stake token still has a mint authority: its supply is not fixed"
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
