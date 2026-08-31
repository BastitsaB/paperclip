import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  CANVAS_CLOSE,
  CANVAS_CONTENT_ENTER,
  CANVAS_CONTENT_EXIT,
  CANVAS_OPEN,
  CANVAS_SWAP_HOLD_MS,
} from "./onboarding-motion";

/**
 * The connect step's input surface: one card that holds whatever the current
 * choice needs, rather than a different control appearing in a different place
 * for each combination.
 *
 * There are four things it can hold — a browser-code login for Claude, a
 * displayed-code login for Codex, and an API key field for either — and they are
 * not the same shape or the same height. Giving each its own slot would move the
 * Connect button every time the choice changed. One canvas that resizes keeps
 * the step's furniture still and makes the card read as the answer to the tile
 * above it.
 *
 * It is closed until a source is picked. An empty card under an untouched row of
 * tiles is a box asking to be filled with nothing.
 */

/** Three lines of body text, so a short prompt and a long one open the same card. */
const MIN_CONTENT_HEIGHT = 66;

export function ConnectInputCanvas({
  open,
  contentKey,
  children,
}: {
  open: boolean;
  /**
   * Identity of what is inside. Changing it swaps the contents through the
   * spinner; it is the source and credential mode together, because either one
   * changing means a different input is needed.
   */
  contentKey: string;
  children: ReactNode;
}) {
  const [shownKey, setShownKey] = useState(contentKey);
  const [swapping, setSwapping] = useState(false);

  // A held beat between the old input leaving and the new one arriving. The
  // panels behind this do fetch, so the spinner is not standing in for nothing —
  // but without a floor, a cached answer swaps instantly and the change reads as
  // a flicker rather than as the card going to get the right thing.
  useEffect(() => {
    if (contentKey === shownKey) return;
    setSwapping(true);
    const id = window.setTimeout(() => {
      setShownKey(contentKey);
      setSwapping(false);
    }, CANVAS_SWAP_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [contentKey, shownKey]);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="canvas"
          // Height from zero rather than a fade: the card unfolds out of the row
          // it belongs to. `overflow-hidden` is what makes that read as an
          // unfolding instead of the contents being clipped mid-fade.
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: CANVAS_OPEN }}
          exit={{ height: 0, opacity: 0, transition: CANVAS_CLOSE }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              "mt-3 rounded-md border border-border bg-card/40 px-3 py-2.5",
              "flex items-center",
            )}
            style={{ minHeight: MIN_CONTENT_HEIGHT }}
          >
            {/*
              The spinner overlays the content rather than replacing it through
              `AnimatePresence mode="wait"`. That arrangement sequences exit
              before enter, and the outgoing input here never reported its exit
              as finished — so the spinner was never mounted and the swap looked
              instant, with the control that was meant to explain it absent.

              Overlaying has no such dependency: the content fades back, the
              spinner fades in over it, and neither waits on the other to
              relinquish the slot.
            */}
            <div className="relative w-full">
              <motion.div
                className="w-full"
                animate={{ opacity: swapping ? 0.15 : 1 }}
                transition={swapping ? CANVAS_CONTENT_EXIT : CANVAS_CONTENT_ENTER}
                // Inert while the answer behind it is being replaced: a field
                // fading out is still focusable, and tabbing into one that is
                // about to be swapped is a trap.
                inert={swapping}
              >
                {children}
              </motion.div>

              <AnimatePresence initial={false}>
                {swapping && (
                  <motion.div
                    key="swapping"
                    className="absolute inset-0 flex items-center justify-center"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: CANVAS_CONTENT_ENTER }}
                    exit={{ opacity: 0, transition: CANVAS_CONTENT_EXIT }}
                  >
                    <Loader2
                      aria-hidden
                      className="size-4 animate-spin text-muted-foreground"
                    />
                    <span className="sr-only">Loading the sign-in for this choice</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The API key field, for when the credential mode is keys rather than a
 * subscription.
 *
 * The variable name is shown rather than described. Someone pasting a key
 * already knows which one they are holding; what they cannot know is where this
 * step will put it, and naming the variable answers that in the place the
 * question is asked.
 */
export function ApiKeyField({
  envKey,
  value,
  onChange,
}: {
  envKey: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount, because the canvas only opens when this is the thing that
  // was asked for. Layout effect so it happens before paint rather than as a
  // visible jump after it.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <label className="flex w-full flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        Paste your <span className="font-mono">{envKey}</span>
      </span>
      <input
        ref={inputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={envKey}
        className={cn(
          "w-full rounded-md border border-border bg-background px-2.5 py-1.5",
          "font-mono text-xs outline-none",
          "focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
        )}
      />
    </label>
  );
}
