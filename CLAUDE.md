# Notes

## Architecture

The file ./ARCHITECTURE.md contains the info about what happens in each file. Keep it up to date.

## Version

To bump the version, simply edit ./src/package.json.

## Before committing

Always run `cd src ; node update-sri.js` to regenerate SRI hashes before every commit. The HTML files use Subresource Integrity attributes that must match the current JS/CSS files.
