import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "../../../tool/types.js";
import { stripFenceMarkers } from "./preview-box-renderer.js";

export type MarkdownFactory = (text: string, markdownTheme: MarkdownTheme) => Markdown;

/** CC parity in side-by-side layout. */
export const MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE = 20;
/** Preserves narrow-terminal protection in stacked layout. */
export const MAX_PREVIEW_HEIGHT_STACKED = 15;
export const NO_PREVIEW_TEXT = "No preview available";
/** Fallback body line when a preview's markdown fails to render (untrusted input boundary). */
export const PREVIEW_RENDER_FAILED_TEXT = "Preview failed to render";
/** 1 blank separator + 1 affordance text row reserved when `hasAnyPreview` (height stability of the affordance row's offset relative to the box). */
export const NOTES_AFFORDANCE_OVERHEAD = 2;

/**
 * One entry per option that carries a preview. `md` is built once and kept for
 * the life of the cache; `lines` are the stripped rows it last produced, and
 * `width` is the inner width they were produced at.
 */
interface PreviewEntry {
  md: ReturnType<MarkdownFactory>;
  width: number | undefined;
  lines: string[] | undefined;
}

/**
 * Per-question cache for rendered markdown previews, keyed per option.
 *
 * Width used to be tracked for the cache as a whole: any change invalidated
 * every `Markdown` it held, so a resize drag re-wrapped all four options one by
 * one through the `maxNaturalHeight` loop even though the frame only measured
 * some of them. Each option now remembers the width it was rendered at, so a
 * width flip costs a re-render of the options that frame actually asks for and
 * nothing else. It also holds the stripped rows, which spares the second strip
 * when `blockHeight` and `renderBlock` ask for the same option in one frame.
 *
 * One Markdown per option, lazy on first request, never re-constructed — count
 * semantics frozen by tests.
 */
export class MarkdownContentCache {
  private readonly previewTexts: Map<number, string>;
  private readonly markdownCache: Map<number, PreviewEntry>;
  private readonly theme: Theme;
  private readonly markdownTheme: MarkdownTheme;
  private readonly markdownFactory: MarkdownFactory;

  constructor(
    question: QuestionData,
    theme: Theme,
    markdownTheme: MarkdownTheme,
    markdownFactory: MarkdownFactory = (text, mt) => new Markdown(text, 0, 0, mt),
  ) {
    this.theme = theme;
    this.markdownTheme = markdownTheme;
    this.markdownFactory = markdownFactory;
    this.previewTexts = new Map();
    for (let i = 0; i < question.options.length; i++) {
      const raw = question.options[i]?.preview;
      if (raw && raw.length > 0) {
        this.previewTexts.set(i, raw);
      }
    }
    this.markdownCache = new Map();
  }

  hasAnyPreview(): boolean {
    return this.previewTexts.size > 0;
  }

  has(optionIndex: number): boolean {
    return this.previewTexts.has(optionIndex);
  }

  /**
   * Body lines for one option at one inner width. A repeat request at the width
   * the option was last rendered at returns the stored rows.
   *
   * Untrusted boundary: `preview` is model-authored markdown and this is the only
   * place it reaches the render path. A `Markdown` that throws (malformed input,
   * width edge cases) must not take the overlay down with it, so the render is
   * wrapped and a single dim fallback line is returned instead. There is no
   * notify channel from the view layer — the fallback line IS the diagnostic.
   * A failed render stores nothing, so the next frame tries again.
   */
  bodyFor(optionIndex: number, innerWidth: number): string[] {
    const text = this.previewTexts.get(optionIndex);
    if (!text) {
      const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
      const pad = Math.max(0, innerWidth - visibleWidth(placeholder));
      return [placeholder + " ".repeat(pad)];
    }
    let entry = this.markdownCache.get(optionIndex);
    if (!entry) {
      entry = {
        md: this.markdownFactory(text, this.markdownTheme),
        width: undefined,
        lines: undefined,
      };
      this.markdownCache.set(optionIndex, entry);
    }
    if (entry.lines !== undefined && entry.width === innerWidth) {
      // A copy: the rows travel into the box renderer and out to the pane, and
      // the cache is the only thing that may hold the originals.
      return [...entry.lines];
    }
    try {
      const lines = stripFenceMarkers(entry.md.render(innerWidth));
      entry.width = innerWidth;
      entry.lines = lines;
      return [...lines];
    } catch {
      entry.width = undefined;
      entry.lines = undefined;
      return [this.theme.fg("dim", PREVIEW_RENDER_FAILED_TEXT)];
    }
  }

  invalidate(): void {
    for (const entry of this.markdownCache.values()) {
      entry.md.invalidate();
      entry.width = undefined;
      entry.lines = undefined;
    }
  }
}
