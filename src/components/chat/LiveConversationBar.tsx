import { Square } from "../icons";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { GRADIENT_CIRCLE } from "../ui/gradientCircle";
import { GLASS_SURFACE } from "../ui/glass";
import type { LiveConversationStatus } from "./useLiveConversation";

interface LiveConversationBarProps {
  status: Exclude<LiveConversationStatus, "idle">;
  caption: string;
  onStop: () => void;
}

// Replaces the text input for the length of a live conversation.
export function LiveConversationBar({ status, caption, onStop }: LiveConversationBarProps) {
  const { t } = useTranslation();
  const label = t(`agentMode.live.${status}`);
  // A caption's informative part is its tail, as in the dictation input.
  const tail = caption.length > 70 ? `…${caption.slice(-70)}` : caption;

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      <div
        className={cn(
          "flex items-center gap-2.5 min-h-11 ps-4 pe-1.5 rounded-full",
          GLASS_SURFACE,
          "border border-black/10 dark:border-white/14"
        )}
      >
        <div
          className={cn(
            "w-2.5 h-2.5 rounded-full shrink-0",
            status === "speaking" ? "bg-accent" : "bg-primary",
            status !== "connecting" && "animate-pulse"
          )}
        />
        <div className="flex-1 min-w-0 flex flex-col leading-tight py-1">
          <span className="text-[12px] text-foreground/80 select-none">{label}</span>
          {tail && (
            <span dir="auto" className="text-[11px] text-muted-foreground truncate">
              {tail}
            </span>
          )}
        </div>
        <button
          onClick={onStop}
          aria-label={t("agentMode.live.stop")}
          title={t("agentMode.live.stop")}
          className={cn(
            "flex items-center justify-center w-7 h-7 rounded-full shrink-0",
            GRADIENT_CIRCLE,
            "hover:brightness-110 active:scale-95",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30",
            "transition-all duration-100"
          )}
        >
          <Square size={10} fill="currentColor" />
        </button>
      </div>
    </div>
  );
}
