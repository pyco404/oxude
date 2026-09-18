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
          "name": "amount",
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
    }
  ],
  "accounts": [
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
    }
  ],
  "events": [
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
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6002,
      "name": "overLimit",
      "msg": "Settlement exceeds the per-match limit"
    },
    {
      "code": 6003,
      "name": "sameAgent",
      "msg": "A match cannot settle an agent against itself"
    },
    {
      "code": 6004,
      "name": "insufficientVault",
      "msg": "The paying vault cannot cover this settlement"
    },
    {
      "code": 6005,
      "name": "invalidLimit",
      "msg": "Limit must be greater than zero"
    }
  ],
  "types": [
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
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
