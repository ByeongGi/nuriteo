import type { ProjectTemplateId } from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { RadioControl, RadioGroupRoot, RadioIndicator } from "#src/components/ui/radio-group.tsx";

const TEMPLATE_OPTIONS: readonly TemplateOption[] = [
  {
    description: "빠른 개발 서버와 React 19 HMR을 갖춘 가벼운 싱글 페이지 앱입니다.",
    eyebrow: "SPA",
    id: "vite-react",
    mark: "V",
    name: "Vite + React",
    recommended: true,
    tags: ["React 19", "TypeScript", "Vite"]
  },
  {
    description: "파일 기반 라우팅과 App Router 미리보기를 사용하는 Next.js 프로젝트입니다.",
    eyebrow: "FULL STACK",
    id: "next-app",
    mark: "N",
    name: "Next.js",
    recommended: false,
    tags: ["Next.js 15", "App Router", "TypeScript"]
  }
];

const pickerStyles = tv({
  slots: {
    root: "col-span-full m-0 grid gap-3 border-0 p-0 max-[48rem]:col-span-1",
    legend: "mb-1 p-0 text-sm font-semibold text-foreground",
    grid: "grid grid-cols-2 gap-3 max-[40rem]:grid-cols-1",
    option: "group relative grid min-h-52 cursor-pointer content-between gap-6 rounded-xl border border-muted-border bg-surface p-4 shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-strong-border hover:shadow-md has-[[data-checked]]:border-primary has-[[data-checked]]:shadow-[0_0_0_1px_var(--n-color-border-focus)] has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60",
    control: "sr-only",
    optionTop: "flex items-start justify-between gap-4",
    mark: "grid size-11 place-items-center rounded-xl bg-subtle text-sm font-bold text-primary group-has-[[data-checked]]:bg-primary group-has-[[data-checked]]:text-on-primary",
    selection: "grid size-5 place-items-center rounded-full border border-strong-border bg-surface before:size-2 before:rounded-full before:bg-transparent group-has-[[data-checked]]:border-primary group-has-[[data-checked]]:before:bg-primary",
    indicator: "size-2 rounded-full bg-primary",
    copy: "grid gap-2 [&_h3]:m-0 [&_h3]:text-lg [&_p]:m-0 [&_p]:text-xs [&_p]:leading-5 [&_p]:text-muted-foreground",
    eyebrow: "text-[0.625rem] font-semibold tracking-[0.12em] text-muted-foreground",
    recommended: "ml-2 inline-flex rounded-full bg-selected px-2 py-1 text-[0.625rem] font-semibold tracking-normal text-primary",
    tags: "flex flex-wrap gap-1.5 [&_span]:rounded-md [&_span]:border [&_span]:border-muted-border [&_span]:bg-subtle [&_span]:px-2 [&_span]:py-1 [&_span]:text-[0.6875rem] [&_span]:font-medium [&_span]:text-muted-foreground",
    hint: "m-0 text-xs leading-5 text-muted-foreground"
  }
});

interface TemplateOption {
  readonly description: string;
  readonly eyebrow: string;
  readonly id: ProjectTemplateId;
  readonly mark: string;
  readonly name: string;
  readonly recommended: boolean;
  readonly tags: readonly string[];
}

const styles = pickerStyles();

export function ProjectTemplatePicker({ disabled }: Readonly<{ disabled: boolean }>) {
  return (
    <fieldset className={styles.root()} disabled={disabled}>
      <legend className={styles.legend()}>시작 템플릿</legend>
      <RadioGroupRoot className={styles.grid()} defaultValue="vite-react" disabled={disabled} name="templateId" required>
        {TEMPLATE_OPTIONS.map((template) => (
          <label className={styles.option()} key={template.id}>
            <RadioControl className={styles.control()} value={template.id}>
              <RadioIndicator className={styles.indicator()} />
            </RadioControl>
            <span className={styles.optionTop()}>
              <span className={styles.mark()} aria-hidden="true">{template.mark}</span>
              <span className={styles.selection()} aria-hidden="true" />
            </span>
            <span className={styles.copy()}>
              <span className={styles.eyebrow()}>{template.eyebrow}{template.recommended ? <span className={styles.recommended()}>추천</span> : null}</span>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
            </span>
            <span className={styles.tags()}>{template.tags.map((tag) => <span key={tag}>{tag}</span>)}</span>
          </label>
        ))}
      </RadioGroupRoot>
      <p className={styles.hint()}>템플릿은 프로젝트 생성 후 변경할 수 없습니다. 다른 프레임워크가 필요하면 새 프로젝트를 만드세요.</p>
    </fieldset>
  );
}
