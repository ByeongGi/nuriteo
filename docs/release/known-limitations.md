# Known limitations

NURITEO Core is the self-hosted edition. Managed cloud, license keys, and phone-home activation are out of scope.

The supported path is desktop Chrome: open a Vite project, install its declared packages, edit, and preview. These are outside that path:

- arbitrary npm packages
- mobile Safari
- Docker in the browser
- native addons

Rollback of a published SDK asset set switches the channel pointer. It does not rewrite an installed database. Database changes move forward only.
