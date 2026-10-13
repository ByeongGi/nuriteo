import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main-content" className="boundary-page" tabIndex={-1}>
      <div className="boundary-card" aria-labelledby="not-found-title">
        <p className="eyebrow">Page not found</p>
        <h1 id="not-found-title">There is no page at this address.</h1>
        <p>Check the address or return to your workspace.</p>
        <Link className="link-button" href="/">
          Return home
        </Link>
      </div>
    </main>
  );
}
