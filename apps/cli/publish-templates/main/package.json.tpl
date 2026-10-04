{
  "name": "@neoxlabs/cli",
  "version": "__VERSION__",
  "description": "Neox CLI · Professional AI code assistant",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=20.0.0"
  },
  "main": "./cli-wrapper.cjs",
  "bin": {
    "neox": "./bin/neox"
  },
  "files": [
    "bin/",
    "install.cjs",
    "uninstall.cjs",
    "cli-wrapper.cjs",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "postinstall": "node install.cjs",
    "preuninstall": "node uninstall.cjs || true"
  },
  "optionalDependencies": {
    "@neoxlabs/cli-darwin-arm64": "__VERSION__",
    "@neoxlabs/cli-linux-x64":    "__VERSION__",
    "@neoxlabs/cli-win32-x64":    "__VERSION__"
  },
  "publishConfig": {
    "access": "public"
  },
  "keywords": [
    "cli",
    "ai",
    "agent",
    "code-assistant"
  ],
  "author": "Neox Labs",
  "homepage": "https://github.com/neoxlabs/OpenNeox",
  "repository": {
    "type": "git",
    "url": "https://github.com/neoxlabs/OpenNeox"
  }
}
