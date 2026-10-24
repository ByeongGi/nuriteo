"use client";

import type { MfaEnrollmentStart } from "@nuriteo/api-client";
import { useMemo } from "react";
import type { FormEvent } from "react";

import { mfaSecurityStyles } from "#src/app/mfa/security.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { createQrMatrix } from "#src/lib/qr-matrix.ts";

export interface MfaEnrollmentPanelProps {
  readonly enrollment: MfaEnrollmentStart;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly pending: boolean;
}

export function MfaEnrollmentPanel({ enrollment, pending, onSubmit }: MfaEnrollmentPanelProps) {
  const matrix = useMemo(() => createQrMatrix(enrollment.provisioningUri), [enrollment.provisioningUri]);
  const styles = mfaSecurityStyles();
  return (
    <section className={styles.card()} aria-labelledby="enrollment-title">
      <h2 id="enrollment-title">인증 앱으로 QR 코드를 스캔하세요</h2>
      <p>이 비밀 키는 지금 한 번만 표시됩니다. QR 코드를 스캔하거나 수동 키를 입력하세요.</p>
      <div className={styles.enrollmentGrid()}>
        <QrCode className={styles.qr()} matrix={matrix} />
        <div className={styles.enrollmentSecret()}><span className={styles.label()}>수동 입력 키</span><code className={styles.secret()}>{enrollment.manualSecret}</code></div>
      </div>
      <form className={styles.codeForm()} onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor="mfa-confirm-code">6자리 인증 코드</label>
        <Input id="mfa-confirm-code" name="code" size="sm" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
        <Button type="submit" size="sm" variant="primary" disabled={pending}>{pending ? "확인 중…" : "확인하고 사용"}</Button>
      </form>
    </section>
  );
}

function QrCode({ className, matrix }: { readonly className: string; readonly matrix: readonly (readonly boolean[])[] }) {
  const size = matrix.length;
  return (
    <svg className={className} viewBox={`0 0 ${size + 8} ${size + 8}`} role="img" aria-label="인증 앱 등록 QR 코드" shapeRendering="crispEdges">
      <rect width={size + 8} height={size + 8} fill="white" />
      {matrix.flatMap((row, rowIndex) => row.map((dark, columnIndex) => dark ? <rect key={`${rowIndex}-${columnIndex}`} x={columnIndex + 4} y={rowIndex + 4} width="1" height="1" fill="black" /> : null))}
    </svg>
  );
}
