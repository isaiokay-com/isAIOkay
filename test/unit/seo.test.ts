import { describe, expect, it } from "vitest";
import { HOME_PAGE_DESCRIPTION, HOME_PAGE_HEADING, HOME_PAGE_TITLE } from "../../src/lib/seo";

describe("homepage SEO positioning", () => {
  it("keeps the search title, snippet, and landing promise aligned", () => {
    const headingCore = HOME_PAGE_HEADING.replace(/^The /, "").replace(/\.$/, "").toLowerCase();

    expect(HOME_PAGE_TITLE.length).toBeGreaterThanOrEqual(50);
    expect(HOME_PAGE_TITLE.length).toBeLessThanOrEqual(60);
    expect(HOME_PAGE_TITLE.toLowerCase()).toContain(headingCore);
    expect(HOME_PAGE_DESCRIPTION.length).toBeGreaterThanOrEqual(150);
    expect(HOME_PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(HOME_PAGE_DESCRIPTION.toLowerCase()).toContain("ai coding model rankings");
  });
});
