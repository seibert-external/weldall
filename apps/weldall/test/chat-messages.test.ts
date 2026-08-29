import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { validateChatMessages } from "../src/server/ai/messages";

const tools = {
  example: tool({
    description: "Example tool",
    inputSchema: z.object({ value: z.string() }).strict(),
  }),
};

describe("chat messages", () => {
  it("strips provider metadata from accepted text parts", async () => {
    const messages = await validateChatMessages([
      {
        id: "message-1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Hello",
            providerMetadata: {
              openaiCompatible: {
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "http://169.254.169.254/latest/meta-data" },
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    ]);
  });

  it("accepts known tool parts and strips provider metadata", async () => {
    const messages = await validateChatMessages(
      [
        {
          id: "message-1",
          role: "assistant",
          parts: [
            {
              type: "tool-example",
              toolCallId: "call-1",
              state: "approval-requested",
              input: { value: "hello" },
              approval: { id: "approval-1", signature: "signed" },
              callProviderMetadata: { provider: { unsafe: true } },
            },
          ],
        },
      ],
      tools,
    );

    expect(messages).toEqual([
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "tool-example",
            toolCallId: "call-1",
            state: "approval-requested",
            input: { value: "hello" },
            approval: { id: "approval-1", signature: "signed" },
          },
        ],
      },
    ]);
  });

  it("rejects unknown tool parts", async () => {
    await expect(
      validateChatMessages(
        [
          {
            id: "message-1",
            role: "assistant",
            parts: [
              {
                type: "tool-unknown",
                toolCallId: "call-1",
                state: "input-available",
                input: {},
              },
            ],
          },
        ],
        tools,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects file parts", async () => {
    await expect(
      validateChatMessages([
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" }],
        },
      ]),
    ).resolves.toBeUndefined();
  });
});
