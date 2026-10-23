import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { AccountNavigation } from "#src/app/(authenticated)/account/_components/account-navigation.tsx";

const accountLayoutStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-6 px-[clamp(1.25rem,4vw,3.5rem)] py-[clamp(1.5rem,4vw,3.5rem)] lg:grid-cols-[13rem_minmax(0,1fr)] max-[48rem]:px-4 max-[48rem]:py-5",
    content: "min-w-0 [&_.workspace-page]:!w-full [&_.workspace-page]:!p-0"
  }
});

export default function AccountLayout({ children }: Readonly<{ children: ReactNode }>) {
  const styles = accountLayoutStyles();
  return (
    <div className={styles.root()} data-slot="account-layout">
      <AccountNavigation />
      <div className={styles.content()}>{children}</div>
    </div>
  );
}

