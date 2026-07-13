import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useTheme } from "./theme";

const ThemeToggle = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <button type="button" onClick={toggleTheme}>
      Current theme: {theme}
    </button>
  );
};

describe("useTheme", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    localStorage.clear();
  });

  it("switches the document from light mode to dark mode", async () => {
    // Given
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // When
    await user.click(screen.getByRole("button", { name: "Current theme: light" }));

    // Then
    expect(screen.getByRole("button", { name: "Current theme: dark" })).toBeVisible();
    expect(document.documentElement).toHaveClass("dark");
  });
});
