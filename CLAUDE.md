# Notes

## Architecture

The file ./ARCHITECTURE.md contains the info about what happens in each file. Keep it up to date.

## Documentation

Both ./ARCHITECTURE.md and ./README.md must be kept up to date as the code evolves. Whenever you add, remove, or meaningfully change a file, feature, env var, API endpoint, or test, update both docs in the same change so they never drift from the code.

## Version

To bump the version, simply edit ./src/package.json.

## Before committing

Always run `cd src ; node update-sri.js` to regenerate SRI hashes before every commit. The HTML files use Subresource Integrity attributes that must match the current JS/CSS files.
