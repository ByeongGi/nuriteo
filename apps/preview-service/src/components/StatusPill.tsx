import clsx from "clsx";

type Tone = "neutral" | "busy" | "ready" | "failed" | "muted";

const toneClass: Record<Tone, string> = {
  neutral: "border-nuriteo-line bg-nuriteo-panel text-nuriteo-ink",
  busy: "border-amber-700/50 bg-amber-950/40 text-nuriteo-warn",
  ready: "border-emerald-700/40 bg-emerald-950/35 text-nuriteo-ok",
  failed: "border-rose-700/40 bg-rose-950/40 text-nuriteo-bad",
  muted: "border-nuriteo-line bg-nuriteo-elevated text-nuriteo-muted"
};

export function StatusPill({
  id,
  label,
  tone = "neutral",
  className
}: {
  id?: string;
  label: string;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      id={id}
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        toneClass[tone],
        className
      )}
    >
      {label}
    </span>
  );
}

export function phaseTone(phase: string): Tone {
  if (phase === "failed") return "failed";
  if (phase === "preview_ready" || phase === "hmr_connected" || phase === "built") return "ready";
  if (phase !== "idle" && phase !== "template_loaded") return "busy";
  return "neutral";
}
