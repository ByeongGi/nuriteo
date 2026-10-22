import type { ComponentProps, ReactNode } from "react";

import { adminFormStyles } from "#src/app/(admin)/admin/_components/admin-form-layout.styles.ts";
import type { VariantProps } from "tailwind-variants";

type AdminFormProps = ComponentProps<"form"> & Pick<VariantProps<typeof adminFormStyles>, "layout">;

function AdminForm({ className, layout, ...props }: AdminFormProps) {
  const styles = adminFormStyles({ layout });
  return <form className={styles.form({ className })} {...props} />;
}

interface AdminFormSectionProps {
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly title: ReactNode;
}

function AdminFormSection({ children, description, title }: AdminFormSectionProps) {
  const styles = adminFormStyles();
  return (
    <section className={styles.section()}>
      <header className={styles.sectionHeader()}>
        <h3 className={styles.sectionTitle()}>{title}</h3>
        <p className={styles.sectionDescription()}>{description}</p>
      </header>
      <div className={styles.fields()}>{children}</div>
    </section>
  );
}

function AdminFormActions({ children }: { readonly children: ReactNode }) {
  const styles = adminFormStyles();
  return <footer className={styles.actions()}>{children}</footer>;
}

function AdminFormActionNote({ children }: { readonly children: ReactNode }) {
  const styles = adminFormStyles();
  return <p data-slot="admin-form-note" className={styles.actionNote()}>{children}</p>;
}

function AdminFormFieldSpan({ children }: { readonly children: ReactNode }) {
  const styles = adminFormStyles();
  return <div className={styles.fieldSpan()}>{children}</div>;
}

function AdminEmptyState({ children, title }: { readonly children: ReactNode; readonly title: ReactNode }) {
  const styles = adminFormStyles();
  return (
    <div className={styles.emptyState()}>
      <strong className={styles.emptyTitle()}>{title}</strong>
      <p className={styles.emptyDescription()}>{children}</p>
    </div>
  );
}

export { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection };
