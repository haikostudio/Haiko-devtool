import { describe, expect, it } from "vitest";

import { resolveAttachmentPreviewKind } from "@/attachments/attachment-preview-kind";

describe("resolveAttachmentPreviewKind", () => {
  it("renders markdown files as markdown", () => {
    expect(resolveAttachmentPreviewKind({ fileName: "README.md" })).toBe("markdown");
    expect(resolveAttachmentPreviewKind({ fileName: "NOTES.MARKDOWN" })).toBe("markdown");
  });

  it("routes SVG away from the raster image view", () => {
    expect(resolveAttachmentPreviewKind({ fileName: "logo.svg" })).toBe("svg");
    expect(resolveAttachmentPreviewKind({ fileName: "logo", mimeType: "image/svg+xml" })).toBe(
      "svg",
    );
  });

  it("recognizes the raster image extensions", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"]) {
      expect(resolveAttachmentPreviewKind({ fileName: name })).toBe("image");
    }
  });

  it("recognizes PDFs", () => {
    expect(resolveAttachmentPreviewKind({ fileName: "devis.pdf" })).toBe("pdf");
    expect(resolveAttachmentPreviewKind({ fileName: "devis", mimeType: "application/pdf" })).toBe(
      "pdf",
    );
  });

  it("falls back to the MIME type when the name carries no usable extension", () => {
    expect(resolveAttachmentPreviewKind({ fileName: "capture", mimeType: "image/png" })).toBe(
      "image",
    );
    expect(
      resolveAttachmentPreviewKind({ fileName: "notes", mimeType: "text/markdown; charset=utf-8" }),
    ).toBe("markdown");
  });

  it("trusts the extension over a generic MIME type", () => {
    expect(
      resolveAttachmentPreviewKind({
        fileName: "capture.png",
        mimeType: "application/octet-stream",
      }),
    ).toBe("image");
  });

  it("reports everything else as unsupported", () => {
    expect(resolveAttachmentPreviewKind({ fileName: "archive.zip" })).toBe("unsupported");
    expect(
      resolveAttachmentPreviewKind({
        fileName: "design.psd",
        mimeType: "image/vnd.adobe.photoshop",
      }),
    ).toBe("unsupported");
    expect(resolveAttachmentPreviewKind({ fileName: "", mimeType: "" })).toBe("unsupported");
  });
});
