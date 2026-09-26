import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";

type LazyFeatureBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
  name: string;
};

type LazyFeatureBoundaryState = {
  error: Error | null;
};

export class LazyFeatureBoundary extends Component<
  LazyFeatureBoundaryProps,
  LazyFeatureBoundaryState
> {
  state: LazyFeatureBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyFeatureBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `Failed to load ${this.props.name}.`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <section
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 border border-cargo-bad/40 bg-cargo-bg/95 p-4 text-center"
          data-lazy-feature-error={this.props.name}
          role="alert"
        >
          <strong className="text-sm text-cargo-ink">
            {this.props.name} failed to load.
          </strong>
          <p className="max-w-md text-xs text-cargo-muted">
            The feature bundle may be stale or unavailable. Reload to request a
            fresh copy.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => window.location.reload()}
          >
            Reload application
          </button>
        </section>
      );
    }

    return (
      <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>
    );
  }
}
