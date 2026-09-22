import clsx from "clsx";

type Tone = "neutral" | "busy" | "ready" | "failed" | "muted";

const toneClass: Record<Tone, string> = {
  neutral: "border-cargo-line bg-cargo-panel text-cargo-ink",
  busy: "border-amber-700/50 bg-amber-950/40 text-cargo-warn",
  ready: "border-emerald-700/40 bg-emerald-950/35 text-cargo-ok",
  failed: "border-rose-700/40 bg-rose-950/40 text-cargo-bad",
  muted: "border-cargo-line bg-cargo-elevated text-cargo-muted"
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
