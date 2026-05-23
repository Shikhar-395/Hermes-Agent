import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonObjectFromResponse,
  parseFounderData,
} from "../src/parser.js";

test("extractJsonObjectFromResponse parses raw JSON payloads", () => {
  const parsed = extractJsonObjectFromResponse(`
    {"founderName":"Alice Johnson","companyName":"Atlas AI","companyDescription":null,"linkedinUrl":null,"twitterHandle":"alicej","website":"https://atlasai.com","ycProfileUrl":null,"batch":"S25","isFounder":true}
  `);

  assert.equal(parsed?.founderName, "Alice Johnson");
  assert.equal(parsed?.isFounder, true);
});

test("parseFounderData retries once after a transient API failure", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  const client = {
    chat: {
      completions: {
        create: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary failure");
          }

          return {
            choices: [
              {
                message: {
                  content:
                    '{"founderName":"Maya Chen","companyName":"LedgerLeaf","companyDescription":"Accounting workflows","linkedinUrl":null,"twitterHandle":"mayachen","website":"https://ledgerleaf.ai","ycProfileUrl":null,"batch":"S25","isFounder":true}',
                },
              },
            ],
          };
        },
      },
    },
  };

  const parsed = await parseFounderData("raw founder text", {
    client,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleepCalls, [3000]);
  assert.equal(parsed?.companyName, "LedgerLeaf");
});
