import { describe, expect, it } from "vitest";

import i18n from "@/shared/i18n";
import { aiErrorText, unsupportedInput } from "../errors";

describe("模型不接受的输入", () => {
  const http = (message: string, statusCode = 422) => ({ name: "AI_APICallError", statusCode, message });

  it("认出“不认识 input_audio / image_url”与常见的不支持说法", () => {
    const deepseek = http(
      "Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `input_audio`, expected one of `text`, `image_url`, `file` at line 1 column 2386576",
    );
    expect(unsupportedInput(deepseek)).toBe("audio");
    expect(unsupportedInput(http("unknown variant `image_url`, expected `text`", 400))).toBe("image");
    expect(unsupportedInput(http("This model does not support image input", 400))).toBe("image");
    expect(unsupportedInput(http("Audio input is not supported for this model", 400))).toBe("audio");
    expect(unsupportedInput(http("Rate limit exceeded", 429))).toBeNull();
    expect(unsupportedInput({ code: "network", message: "audio not supported" })).toBeNull();
  });

  it("文案说明是哪种输入、怎么关掉", async () => {
    await i18n.changeLanguage("zh");
    const text = aiErrorText(i18n.t, http("unknown variant `input_audio`, expected one of `text`"));
    expect(text).toContain("不接受音频");
    expect(text).toContain("422");
  });
});
