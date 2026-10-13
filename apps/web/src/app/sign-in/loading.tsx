export default function SignInLoading() {
  return (
    <main id="main-content" className="entry-page" aria-busy="true" aria-live="polite">
      <p className="sr-only">Checking your session</p>
      <div className="entry-card entry-card--compact entry-card--loading" aria-hidden="true">
        <div className="loading-shell__line loading-shell__line--short" />
        <div className="loading-shell__line loading-shell__line--title" />
        <div className="loading-shell__line" />
      </div>
    </main>
  );
}
