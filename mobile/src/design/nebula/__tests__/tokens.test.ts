import { contrastRatio, nebulaLayout, nebulaPalette, nebulaTouch, nebulaTypography } from "../tokens";

describe("Nebula semantic tokens", () => {
  it("provides minimum accessible font and action sizing", () => {
    expect(nebulaTouch.minimum).toBeGreaterThanOrEqual(48);
    expect(nebulaLayout.referenceWidths).toEqual([320, 360, 390, 430]);
    expect(nebulaTypography.body.lineHeight).toBeGreaterThan(nebulaTypography.body.fontSize);
  });
  it.each(["dark", "light"] as const)("keeps readable text in the %s theme", scheme => {
    const theme = nebulaPalette[scheme];
    expect(contrastRatio(theme.text, theme.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.textSecondary, theme.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.textOnAccent, theme.accent)).toBeGreaterThanOrEqual(4.5);
  });
  it("rejects invalid or unapproved color input", () => {
    expect(() => contrastRatio("cyan", "#123456")).toThrow("#RRGGBB");
  });
});
