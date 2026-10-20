interface AdminAccessRequiredProps {
  readonly description: string;
}

export function AdminAccessRequired({ description }: AdminAccessRequiredProps) {
  return (
    <main id="main-content" className="workspace-page" tabIndex={-1}>
      <section className="access-required" aria-labelledby="admin-access-required-title">
        <span className="access-required__mark" aria-hidden="true">◇</span>
        <div>
          <p className="eyebrow">Restricted area</p>
          <h1 id="admin-access-required-title">Administrator access required</h1>
          <p>{description}</p>
        </div>
      </section>
    </main>
  );
}
