# Dependencies

The files of each package the server loads, copied from its published release by
`mcp/scripts/package.mjs`. Only import paths differ from the release: each points
straight at the file Node would have loaded. Two modules nothing calls are left
out and replaced by the short files in `../stand-ins/`.

| Package | Version | Licence |
| --- | --- | --- |
| @modelcontextprotocol/sdk | 1.30.0 | MIT |
| zod | 4.6.5 | MIT |
| zod-to-json-schema | 3.25.2 | ISC |
