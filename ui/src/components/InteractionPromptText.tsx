import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";

/**
 * Question and prompt text written by agents. Rendered as Markdown so
 * paragraphs and lists survive (plain text collapsed them into one block).
 * The inherit modifier keeps the surrounding card's size, colour and weight,
 * so prompt and help text keep their hierarchy. Media stays a reference:
 * question text is not a media container and must not load external images.
 */
export function InteractionPromptText({
  children,
  externalReferences,
  linkIssueReferences,
}: {
  children: string;
  externalReferences?: MarkdownExternalReferenceMap;
  linkIssueReferences?: boolean;
}) {
  return (
    <MarkdownBody
      className="paperclip-markdown-inherit"
      mediaMode="reference"
      externalReferences={externalReferences}
      linkIssueReferences={linkIssueReferences}
    >
      {children}
    </MarkdownBody>
  );
}
