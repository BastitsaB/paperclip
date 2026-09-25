import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDayAwareTime } from "@/lib/timeAgo";

export type RoutineActivityEvent = Pick<ActivityEvent, "id" | "action" | "details" | "createdAt">;

/**
 * "08:16 PM" for an event from today, "Sep 20, 08:16 PM" once it is no
 * longer from today — the row previously showed a bare clock time with no
 * date, so a log read after midnight could not tell today's entries from
 * yesterday's (or older).
 */
function formatTime(value: string | Date): string {
  try {
    return formatDayAwareTime(value);
  } catch {
    return String(value);
  }
}

function summarizeDetails(details: Record<string, unknown> | null | undefined): string {
  if (!details) return "";
  const entries = Object.entries(details).slice(0, 3);
  return entries
    .map(([key, value]) => `${key.replaceAll("_", " ")}: ${formatDetailValue(value)}`)
    .join(" · ");
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.map(formatDetailValue).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** Activity log row with an expandable JSON payload (§3.7). */
export function RoutineActivityRow({ event }: { event: RoutineActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = event.details != null && Object.keys(event.details).length > 0;

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        disabled={!hasPayload}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 px-1 py-2 text-left text-xs",
          hasPayload ? "hover:bg-accent/30" : "cursor-default",
        )}
      >
        <span className="shrink-0 whitespace-nowrap font-mono text-muted-foreground/70">
          {formatTime(event.createdAt)}
        </span>
        <Badge variant="outline" className="shrink-0 font-mono">
          {event.action}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summarizeDetails(event.details)}
        </span>
        {hasPayload ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {expanded && hasPayload ? (
        <pre className="mx-1 mb-2 overflow-x-auto rounded-md bg-neutral-950 p-3 font-mono text-xs text-neutral-200">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
