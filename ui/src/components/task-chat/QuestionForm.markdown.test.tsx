// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { QuestionForm } from "./QuestionForm";
import { ThemeProvider } from "../../context/ThemeContext";

vi.mock("./TaskChatRichInput", () => ({
  TaskChatRichInput: ({ value, onChange }: { value: string; onChange(value: string): void }) =>
    <textarea aria-label="Answer" value={value} onChange={event => onChange(event.target.value)} />,
}));

// Real MarkdownBody on purpose: the modal must keep paragraphs and lists of agent questions.
const questionSet: PaperclipQuestionSet = { schema: "paperclip.question_set.v1", questions: [{
  id: "rollout", required: true, answerMode: "text",
  prompt: "Decide the rollout.\n\nOptions:\n\n- keep the scan\n- loosen the classifier",
  helpText: "Not checked:\n\n- runtime effect",
}] };

describe("QuestionForm structured prompts", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });

  it("renders prompt and help text as paragraphs and lists while labels stay plain text", async () => {
    await act(async () => root.render(<ThemeProvider><QuestionForm id="md" questionSet={questionSet} draftKey="question-md" onSubmit={vi.fn()} /></ThemeProvider>));
    const prompt = container.querySelector("#md-rollout-prompt")!;
    expect(prompt.querySelectorAll("p").length).toBeGreaterThanOrEqual(2);
    expect(Array.from(prompt.querySelectorAll("li")).map(item => item.textContent)).toEqual(["keep the scan", "loosen the classifier"]);
    expect(Array.from(container.querySelectorAll("li")).map(item => item.textContent)).toContain("runtime effect");
    // Help text keeps the muted compact style instead of the article defaults.
    const help = Array.from(container.querySelectorAll(".paperclip-markdown-inherit")).find(node => node.textContent?.includes("runtime effect"))!;
    expect(help.parentElement!.className).toContain("text-muted-foreground");
    expect(help.querySelector("img")).toBeNull();
  });
});
