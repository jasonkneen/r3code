import { expect, test } from "nsh/test";
import { STANDARD_COLORS } from "../../themePaletteData";
import { generateLiveTheme } from "./liveThemeGenerator";

test("generateLiveTheme produces distinct tokens for built-in themes and standard default", () => {
  const ocean = generateLiveTheme({ light: "ocean", dark: "ocean", contrast: 100 });
  const ember = generateLiveTheme({ light: "ember", dark: "ember", contrast: 100 });
  const standard = generateLiveTheme({ light: "default", dark: "default", contrast: 100 });

  expect(ocean.cssVars.dark.background).not.toBe(ember.cssVars.dark.background);
  expect(ocean.cssVars.dark.primary).not.toBe(ember.cssVars.dark.primary);
  expect(standard.cssVars.dark.background).toBe("rgb(0,0,0)");
  expect(ember.cssVars.dark["border-60"]).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  expect(ember.cssVars.light["segmented-track"]).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
});

test("generateLiveTheme adjusts contrast and supports custom themes", () => {
  const normal = generateLiveTheme({ light: "ocean", dark: "ocean", contrast: 100 });
  const boosted = generateLiveTheme({ light: "ocean", dark: "ocean", contrast: 160 });
  expect(boosted.cssVars.dark["muted-foreground"]).not.toBe(normal.cssVars.dark["muted-foreground"]);

  const custom = generateLiveTheme(
    { light: "ocean", dark: "my-custom", contrast: 100 },
    [{
      id: "my-custom",
      label: "My Custom",
      appearance: "dark",
      colors: { ...STANDARD_COLORS.dark, canvas: "#12131a", messageAction: "#ff5500" },
    }],
  );
  expect(custom.cssVars.dark.background).toBe("rgb(18,19,26)");
  expect(custom.cssVars.dark.primary).toBe("rgb(255,85,0)");
});
