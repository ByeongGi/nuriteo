# SDK Publish Rehearsal

`@nuriteo/sdk@0.1.0-beta.1` is packaged and publish-rehearsed, but this repository state does not claim that a registry upload occurred.

## Channel and artifact

- Version: `0.1.0-beta.1`
- npm dist-tag: `beta`
- Access: public
- Artifact: `dist/sdk/nuriteo-sdk-0.1.0-beta.1.tgz`
- Entrypoints: ESM `index.js`, CommonJS `index.cjs`, declarations `index.d.ts`
- Provenance: required for the real publish from the trusted release workflow

The dry run operates on the tarball, not the mutable package directory. It verifies the exact files intended for upload and never contacts the registry for a write.

## Migration note

This beta promotes adapter-backed filesystem, package-manager, preview, project, process, tracing, worker asset resolution, preview Service Worker registration, and the NURITEO WebContainer-style facade. Existing `createContainer()` lifecycle calls remain compatible. `NuriteoMountSnapshot` is a NURITEO-specific versioned format; it is not advertised as a drop-in WebContainer snapshot.

## Publish-time procedure

The release owner reruns the documented package, consumer, fingerprint, provenance, and dry-run gates from a clean checkout. Only the trusted release workflow may then execute the real publish with npm provenance enabled. This task intentionally does not run that command.

## Rollback rehearsal

Record the currently verified beta version before promotion. If the new beta is faulty, keep the immutable artifact for incident analysis, deprecate the faulty version, and repoint the channel:

```sh
npm dist-tag add @nuriteo/sdk@<previous-beta-version> beta
npm deprecate @nuriteo/sdk@<faulty-version> "Use the beta dist-tag rollback version"
```

Do not use `npm unpublish` as the normal rollback mechanism. Re-run the consumer matrix after the dist-tag change and link the incident to the artifact fingerprint.
