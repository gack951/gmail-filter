import { describe, expect, it } from "vitest";
import { parseMessageContent } from "../src/message";

const encoded = (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("parseMessageContent", () => {
  it("ヘッダーとmultipart本文を部分一致確認用テキストへ変換する", () => {
    const message = parseMessageContent({
      id: "message-1",
      snippet: "本文の抜粋",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "お店 <shop@example.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "秋の限定セール" },
        ],
        parts: [{ mimeType: "text/plain", filename: "", body: { data: encoded("Coupon code is FAMILY") } }],
      },
    });

    expect(message).toMatchObject({
      fromAddress: "shop@example.com",
      subject: "秋の限定セール",
      text: "Coupon code is FAMILY",
      truncated: false,
    });
  });
});
