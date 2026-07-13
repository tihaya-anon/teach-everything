import { describe, expect, it } from "vitest";
import { createUserSchema } from "./user";

describe("createUserSchema", () => {
  it("accepts a user name and email without an id", () => {
    // Given
    const input = {
      name: "Ada Lovelace",
      email: "ada@example.com",
    };

    // When
    const result = createUserSchema.safeParse(input);

    // Then
    expect(result.success).toBe(true);
  });
});
