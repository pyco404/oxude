/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/oxude_settlement.json`.
 */
export type OxudeSettlement = {
  "address": "EKJHJ8jsuXQ9hzy4qPXMsAHDagA38C1pkDWoz3un8kir",
  "metadata": {
    "name": "oxudeSettlement",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Oxude devnet settlement: game currency, agent vaults, match settlement records"
  },
  "instructions": [
    {
      "name": "initialize",
      "docs": [
        "One-time setup: the config, and the game currency's mint (0 decimals,",
        "minted only by the config PDA)."
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
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
        "Opens a player's agent's vault and records its owner, together. The",
        "agent id must be the hash of that owner's key and the salt, so this is",
        "the only owner the agent can ever have: whoever sends it, the settler",
        "included, can't record another, and the record can't be created twice."
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
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "mintBudget",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  98,
                  117,
                  100,
                  103,
                  101,
                  116
                ]
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
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openVault",
      "docs": [
        "Opens an agent's vault and funds it with its starting balance. Called",
        "when an agent is rented."
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
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "mintBudget",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  98,
                  117,
                  100,
                  103,
                  101,
                  116
                ]
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
          "name": "amount",
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
        "program upgrade, and it is bounded by `MAX_SEED` so that a stolen admin",
        "key cannot turn the per-settlement guard off altogether."
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
      "name": "mintBudget",
      "discriminator": [
        181,
        222,
        114,
        222,
        106,
        138,
        162,
        11
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
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6003,
      "name": "overLimit",
      "msg": "Settlement exceeds the per-match limit"
    },
    {
      "code": 6004,
      "name": "sameAgent",
      "msg": "A match cannot settle an agent against itself"
    },
    {
      "code": 6005,
      "name": "insufficientVault",
      "msg": "The paying vault cannot cover this settlement"
    },
    {
      "code": 6006,
      "name": "invalidLimit",
      "msg": "Limit must be greater than zero"
    },
    {
      "code": 6007,
      "name": "notOwner",
      "msg": "Only the agent's recorded owner can withdraw"
    },
    {
      "code": 6008,
      "name": "notOwnersAccount",
      "msg": "Withdrawals go only to the owner's own token account"
    },
    {
      "code": 6009,
      "name": "ledgerMismatch",
      "msg": "The vault doesn't match the ledger: a settlement is still in flight"
    },
    {
      "code": 6010,
      "name": "unplayable",
      "msg": "A withdrawal must leave the vault empty or with at least the minimum stake"
    },
    {
      "code": 6011,
      "name": "agentIdMismatch",
      "msg": "The agent id isn't the hash of this owner and salt"
    },
    {
      "code": 6012,
      "name": "outflowLimit",
      "msg": "This vault has paid out all it can in this window"
    },
    {
      "code": 6013,
      "name": "mintLimit",
      "msg": "New vaults have minted all they can in this window"
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
          },
          {
            "name": "mintBump",
            "type": "u8"
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
      "name": "mintBudget",
      "docs": [
        "One for the program: how much new vaults have minted in the current window."
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
          },
          {
            "name": "amount",
            "type": "u64"
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
