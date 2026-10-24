import { tv } from "tailwind-variants";

const connectionGuideStyles = tv({
  slots: {
    root: "m-0 grid list-none grid-cols-3 overflow-hidden rounded-md border border-muted-border bg-subtle p-0",
    step: "grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 border-r border-muted-border px-4 py-3 last:border-r-0 max-[42rem]:grid-cols-1 max-[42rem]:justify-items-center max-[42rem]:gap-1 max-[42rem]:px-2 max-[42rem]:py-2.5 max-[42rem]:text-center",
    marker: "grid size-6 place-items-center rounded-full bg-selected text-[0.6875rem] font-semibold text-link",
    copy: "grid min-w-0 gap-0.5",
    label: "text-xs font-semibold text-foreground",
    description: "text-[var(--n-font-size-2xs)] leading-5 text-muted-foreground max-[42rem]:hidden"
  }
});

interface AdminConnectionGuideProps {
  readonly subject: string;
}

export function AdminConnectionGuide({ subject }: AdminConnectionGuideProps) {
  const styles = connectionGuideStyles();
  const steps = [
    { label: "설정 저장", description: `${subject} 정보를 비활성 상태로 저장합니다.` },
    { label: "연결 검증", description: "주소, 인증 정보와 네트워크 연결을 점검합니다." },
    { label: "활성화", description: "검증을 통과한 연결만 서비스에 사용합니다." }
  ] as const;

  return (
    <ol className={styles.root()} aria-label={`${subject} 연결 절차`}>
      {steps.map((step, index) => (
        <li className={styles.step()} key={step.label}>
          <span className={styles.marker()} aria-hidden="true">{index + 1}</span>
          <span className={styles.copy()}>
            <strong className={styles.label()}>{step.label}</strong>
            <span className={styles.description()}>{step.description}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
