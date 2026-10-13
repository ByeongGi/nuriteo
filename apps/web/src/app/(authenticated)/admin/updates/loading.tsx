export default function AdminUpdatesLoading() {
  return (
    <main id="main-content" className="workspace-page" aria-busy="true" aria-live="polite">
      <header className="workspace-page__intro">
        <p className="eyebrow">Instance administration</p>
        <h1>Update readiness</h1>
        <p>Checking the compatibility contract and read-only preflight status…</p>
      </header>
    </main>
  );
}
