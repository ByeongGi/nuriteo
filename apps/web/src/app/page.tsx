import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Workspace"
};

const FOUNDATIONS = [
  {
    description: "The same semantic roles adapt across Forge Light and Forge Dark.",
    label: "Theme ready",
    status: "System-aware"
  },
  {
    description: "Server Components remain the default until interaction requires a client boundary.",
    label: "Rendering ready",
    status: "Server-first"
  },
  {
    description: "Safe loading, not-found, and recovery boundaries are available at the root.",
    label: "Recovery ready",
    status: "Bounded"
  }
] as const;

export default function HomePage() {
  return (
    <main id="main-content" className="shell-main" tabIndex={-1}>
      <section className="hero" aria-labelledby="workspace-title">
        <div className="hero__copy">
          <p className="eyebrow">Self-hosted workspace</p>
          <h1 id="workspace-title">A clear starting point for work that stays yours.</h1>
          <p className="hero__description">
            The NURITEO web shell is ready. Account, workspace, and project flows will connect
            through the Core API in the next product slices.
          </p>
        </div>
        <div className="shell-status" role="status" aria-label="Web shell status">
          <span className="shell-status__dot" aria-hidden="true" />
          Web shell running
        </div>
      </section>

      <section className="foundation-section" aria-labelledby="foundation-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Foundation</p>
            <h2 id="foundation-title">Designed for the service journey ahead</h2>
          </div>
          <p>Only capabilities available in this shell are shown.</p>
        </div>
        <div className="foundation-grid">
          {FOUNDATIONS.map((foundation) => (
            <article className="foundation-card" key={foundation.label}>
              <div className="foundation-card__heading">
                <h3>{foundation.label}</h3>
                <span>{foundation.status}</span>
              </div>
              <p>{foundation.description}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
