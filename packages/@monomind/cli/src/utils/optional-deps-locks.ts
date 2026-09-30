/**
 * npm lockfiles for the packages ensureOptionalDependency() installs (#428).
 * `npm ci` installs exactly these trees and checks every tarball against the
 * `integrity` recorded here, so a registry or ~/.npmrc that serves other
 * bytes fails the install instead of changing what runs.
 *
 * Regenerate after changing a pin in optional-deps.ts: in an empty directory,
 * write {"name":"monomind-optional-dependency","private":true,
 * "dependencies":{"<name>":"<version>"}} as package.json, run
 * `npm install --package-lock-only --legacy-peer-deps --ignore-scripts`, and
 * paste package-lock.json below. optional-deps.test.ts checks the pins match.
 */
export const OPTIONAL_DEPENDENCY_LOCKS = {
  '@anthropic-ai/claude-agent-sdk': {
    name: 'monomind-optional-dependency',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'monomind-optional-dependency',
        dependencies: {
          '@anthropic-ai/claude-agent-sdk': '0.3.226',
        },
      },
      'node_modules/@anthropic-ai/claude-agent-sdk': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.226.tgz',
        integrity:
          'sha512-RvaZCZSKGjNIN/bDrQbyq/XkjVaUAPThxFrwFz2jdl6DvGnUtsGlt7hmPsaGC6BDudbA8yvkZFSqaJveK3WhfQ==',
        license: 'SEE LICENSE IN README.md',
        engines: {
          node: '>=18.0.0',
        },
        optionalDependencies: {
          '@anthropic-ai/claude-agent-sdk-darwin-arm64': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-darwin-x64': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-linux-arm64': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-linux-arm64-musl': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-linux-x64': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-linux-x64-musl': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-win32-arm64': '0.3.226',
          '@anthropic-ai/claude-agent-sdk-win32-x64': '0.3.226',
        },
        peerDependencies: {
          '@anthropic-ai/sdk': '>=0.93.0',
          '@modelcontextprotocol/sdk': '^1.29.0',
          zod: '^4.0.0',
        },
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.226.tgz',
        integrity:
          'sha512-ycyuSgN2XaSYdze1eM2wDwNmXS5wPqIh1RxiDs99ywPr9lpe3Y/Xcv0nz9JN5ahNoPIgWHIfI9Ac1EWCOdIF1Q==',
        cpu: ['arm64'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['darwin'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.226.tgz',
        integrity:
          'sha512-sOOCkhtMDGVKs6k3fpTAkCML974qOnt8Bm9zlC6rV0HkM0aP4bdDY1RAlKLF4fHmOP2s5fPTY3myZiHGDFnuUg==',
        cpu: ['x64'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['darwin'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.226.tgz',
        integrity:
          'sha512-YNwwC37m2vcY47mWZGqRmDh2ZSrO0Z01iTlIDsPmvKv03+7pwyaXVuq01Evtyp7see+KGeIYkMN37HhEt/h+8Q==',
        cpu: ['arm64'],
        libc: ['glibc'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['linux'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/-/claude-agent-sdk-linux-arm64-musl-0.3.226.tgz',
        integrity:
          'sha512-w/hsZ2SqJTyPxLgQiK6X0c2yQJ1W3jAJW5UV0gXLq6wnzUeOnHVtG+TnJu2LuHseHovRqDQ9t8EsDgnZE0vdlA==',
        cpu: ['arm64'],
        libc: ['musl'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['linux'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.226.tgz',
        integrity:
          'sha512-gPoHNeko9E+bmKVPRiAcCAOyBBrVcIH/WdjmyaGVoTP2bKibTs978A42rMNtAnuPBcAGAiImQimUU7w1TXESFw==',
        cpu: ['x64'],
        libc: ['glibc'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['linux'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64-musl/-/claude-agent-sdk-linux-x64-musl-0.3.226.tgz',
        integrity:
          'sha512-sMRt4ocfctoYLxPKpbOUd8hHhoMz2eQX8d3DN78Gl8r4uTpsDz5NCFLdkk7ikuRzXvoMPzUrFy+wFVIF0B7TLA==',
        cpu: ['x64'],
        libc: ['musl'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['linux'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-arm64/-/claude-agent-sdk-win32-arm64-0.3.226.tgz',
        integrity:
          'sha512-qkzWTR3Ns8PimC5rx4+cwfuyHlCRocGIAcdWDUgpnI70qH5GlqX9R0VfM7wGOCs/C+fJ04Hg0GfAkMv4xriZwA==',
        cpu: ['arm64'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['win32'],
      },
      'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64': {
        version: '0.3.226',
        resolved:
          'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.226.tgz',
        integrity:
          'sha512-uxVbLwGSX6lvO5Tazv0gZu8WSg1o14DQsqGSY+5pDNUk28KmNbFIQAjky9KeDzk9lnf63/aQPPsaq6UAikWjqA==',
        cpu: ['x64'],
        license: 'SEE LICENSE IN LICENSE.md',
        optional: true,
        os: ['win32'],
      },
    },
  },
  '@puppeteer/browsers': {
    name: 'monomind-optional-dependency',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'monomind-optional-dependency',
        dependencies: {
          '@puppeteer/browsers': '3.0.6',
        },
      },
      'node_modules/@puppeteer/browsers': {
        version: '3.0.6',
        resolved: 'https://registry.npmjs.org/@puppeteer/browsers/-/browsers-3.0.6.tgz',
        integrity:
          'sha512-B/gKoqlFkzhvzsI6jo9K1cZz9o5ypviVv/xu8CwA4grZzyVwN+XfkT+tu8T1zrauuEXv6VhS2oGX+6NL95WcKA==',
        license: 'Apache-2.0',
        dependencies: {
          'modern-tar': '^0.7.6',
          yargs: '^18.0.0',
        },
        bin: {
          browsers: 'lib/main-cli.js',
        },
        engines: {
          node: '>=22.12.0',
        },
        peerDependencies: {
          'proxy-agent': '>=8.0.1',
          yauzl: '^2.10.0 || ^3.4.0',
        },
        peerDependenciesMeta: {
          'proxy-agent': {
            optional: true,
          },
          yauzl: {
            optional: true,
          },
        },
      },
      'node_modules/ansi-regex': {
        version: '6.4.0',
        resolved: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-6.4.0.tgz',
        integrity:
          'sha512-KzTVk2tCWAHtYrvvvaP8bJKJq2pVinhLcGEQdtLIYPbmNGNyYe8QwNaTUYQp2J7/vIsUKt5QCqAfUkYyG9DkOw==',
        license: 'MIT',
        engines: {
          node: '>=12',
        },
        funding: {
          url: 'https://github.com/chalk/ansi-regex?sponsor=1',
        },
      },
      'node_modules/ansi-styles': {
        version: '6.2.3',
        resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-6.2.3.tgz',
        integrity:
          'sha512-4Dj6M28JB+oAH8kFkTLUo+a2jwOFkuqb3yucU0CANcRRUbxS0cP0nZYCGjcc3BNXwRIsUVmDGgzawme7zvJHvg==',
        license: 'MIT',
        engines: {
          node: '>=12',
        },
        funding: {
          url: 'https://github.com/chalk/ansi-styles?sponsor=1',
        },
      },
      'node_modules/cliui': {
        version: '9.0.1',
        resolved: 'https://registry.npmjs.org/cliui/-/cliui-9.0.1.tgz',
        integrity:
          'sha512-k7ndgKhwoQveBL+/1tqGJYNz097I7WOvwbmmU2AR5+magtbjPWQTS1C5vzGkBC8Ym8UWRzfKUzUUqFLypY4Q+w==',
        license: 'ISC',
        dependencies: {
          'string-width': '^7.2.0',
          'strip-ansi': '^7.1.0',
          'wrap-ansi': '^9.0.0',
        },
        engines: {
          node: '>=20',
        },
      },
      'node_modules/cliui/node_modules/string-width': {
        version: '7.2.0',
        resolved: 'https://registry.npmjs.org/string-width/-/string-width-7.2.0.tgz',
        integrity:
          'sha512-tsaTIkKW9b4N+AEj+SVA+WhJzV7/zMhcSu78mLKWSk7cXMOSHsBKFWUs0fWwq8QyK3MgJBQRX6Gbi4kYbdvGkQ==',
        license: 'MIT',
        dependencies: {
          'emoji-regex': '^10.3.0',
          'get-east-asian-width': '^1.0.0',
          'strip-ansi': '^7.1.0',
        },
        engines: {
          node: '>=18',
        },
        funding: {
          url: 'https://github.com/sponsors/sindresorhus',
        },
      },
      'node_modules/emoji-regex': {
        version: '10.6.0',
        resolved: 'https://registry.npmjs.org/emoji-regex/-/emoji-regex-10.6.0.tgz',
        integrity:
          'sha512-toUI84YS5YmxW219erniWD0CIVOo46xGKColeNQRgOzDorgBi1v4D71/OFzgD9GO2UGKIv1C3Sp8DAn0+j5w7A==',
        license: 'MIT',
      },
      'node_modules/escalade': {
        version: '3.2.0',
        resolved: 'https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz',
        integrity:
          'sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==',
        license: 'MIT',
        engines: {
          node: '>=6',
        },
      },
      'node_modules/get-caller-file': {
        version: '2.0.5',
        resolved: 'https://registry.npmjs.org/get-caller-file/-/get-caller-file-2.0.5.tgz',
        integrity:
          'sha512-DyFP3BM/3YHTQOCUL/w0OZHR0lpKeGrxotcHWcqNEdnltqFwXVfhEBQ94eIo34AfQpo0rGki4cyIiftY06h2Fg==',
        license: 'ISC',
        engines: {
          node: '6.* || 8.* || >= 10.*',
        },
      },
      'node_modules/get-east-asian-width': {
        version: '1.7.0',
        resolved:
          'https://registry.npmjs.org/get-east-asian-width/-/get-east-asian-width-1.7.0.tgz',
        integrity:
          'sha512-XjH1AECxf0giL2V1aU8vKyRR2ppRUb5c0EvT7zuJTokQ74bNo52zOtghqdWIqrhUD79fo3x0WfKZdOqxF6LG1Q==',
        license: 'MIT',
        engines: {
          node: '>=18',
        },
        funding: {
          url: 'https://github.com/sponsors/sindresorhus',
        },
      },
      'node_modules/modern-tar': {
        version: '0.7.7',
        resolved: 'https://registry.npmjs.org/modern-tar/-/modern-tar-0.7.7.tgz',
        integrity:
          'sha512-t9VmxaqrmANnEOBhpSDI6HD192Ge48k8vmWqQQL7hSFEqHEYwZbbsu49+aKLWZeRvFs3j1pMhXOqqF4kPlvjkQ==',
        license: 'MIT',
        engines: {
          node: '>=18.0.0',
        },
      },
      'node_modules/string-width': {
        version: '8.3.0',
        resolved: 'https://registry.npmjs.org/string-width/-/string-width-8.3.0.tgz',
        integrity:
          'sha512-ZbmZM0JCihQN91dWnxoipT2KOEyHqEyfRXUyjuRhW8b/xnqPDoq4gWEVApTVa9db2wN8mmoikgFBbjh71+cGeQ==',
        license: 'MIT',
        dependencies: {
          'get-east-asian-width': '^1.5.0',
          'strip-ansi': '^7.1.2',
        },
        engines: {
          node: '>=20',
        },
        funding: {
          url: 'https://github.com/sponsors/sindresorhus',
        },
      },
      'node_modules/strip-ansi': {
        version: '7.2.0',
        resolved: 'https://registry.npmjs.org/strip-ansi/-/strip-ansi-7.2.0.tgz',
        integrity:
          'sha512-yDPMNjp4WyfYBkHnjIRLfca1i6KMyGCtsVgoKe/z1+6vukgaENdgGBZt+ZmKPc4gavvEZ5OgHfHdrazhgNyG7w==',
        license: 'MIT',
        dependencies: {
          'ansi-regex': '^6.2.2',
        },
        engines: {
          node: '>=12',
        },
        funding: {
          url: 'https://github.com/chalk/strip-ansi?sponsor=1',
        },
      },
      'node_modules/wrap-ansi': {
        version: '9.0.2',
        resolved: 'https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-9.0.2.tgz',
        integrity:
          'sha512-42AtmgqjV+X1VpdOfyTGOYRi0/zsoLqtXQckTmqTeybT+BDIbM/Guxo7x3pE2vtpr1ok6xRqM9OpBe+Jyoqyww==',
        license: 'MIT',
        dependencies: {
          'ansi-styles': '^6.2.1',
          'string-width': '^7.0.0',
          'strip-ansi': '^7.1.0',
        },
        engines: {
          node: '>=18',
        },
        funding: {
          url: 'https://github.com/chalk/wrap-ansi?sponsor=1',
        },
      },
      'node_modules/wrap-ansi/node_modules/string-width': {
        version: '7.2.0',
        resolved: 'https://registry.npmjs.org/string-width/-/string-width-7.2.0.tgz',
        integrity:
          'sha512-tsaTIkKW9b4N+AEj+SVA+WhJzV7/zMhcSu78mLKWSk7cXMOSHsBKFWUs0fWwq8QyK3MgJBQRX6Gbi4kYbdvGkQ==',
        license: 'MIT',
        dependencies: {
          'emoji-regex': '^10.3.0',
          'get-east-asian-width': '^1.0.0',
          'strip-ansi': '^7.1.0',
        },
        engines: {
          node: '>=18',
        },
        funding: {
          url: 'https://github.com/sponsors/sindresorhus',
        },
      },
      'node_modules/y18n': {
        version: '5.0.8',
        resolved: 'https://registry.npmjs.org/y18n/-/y18n-5.0.8.tgz',
        integrity:
          'sha512-0pfFzegeDWJHJIAmTLRP2DwHjdF5s7jo9tuztdQxAhINCdvS+3nGINqPd00AphqJR/0LhANUS6/+7SCb98YOfA==',
        license: 'ISC',
        engines: {
          node: '>=10',
        },
      },
      'node_modules/yargs': {
        version: '18.2.0',
        resolved: 'https://registry.npmjs.org/yargs/-/yargs-18.2.0.tgz',
        integrity:
          'sha512-9OpKOLeaoNFecEp7P6iYbzze/5CqWoH7N3SMs/6y1XF4nMvFMspEGZzJ6uFi9MmQwXhyzqYoSEKO3tvA3Z/o2w==',
        license: 'MIT',
        dependencies: {
          cliui: '^9.0.1',
          escalade: '^3.1.1',
          'get-caller-file': '^2.0.5',
          'string-width': '^8.2.1',
          y18n: '^5.0.5',
          'yargs-parser': '^22.0.0',
        },
        engines: {
          node: '^20.19.0 || ^22.12.0 || >=23',
        },
      },
      'node_modules/yargs-parser': {
        version: '22.0.0',
        resolved: 'https://registry.npmjs.org/yargs-parser/-/yargs-parser-22.0.0.tgz',
        integrity:
          'sha512-rwu/ClNdSMpkSrUb+d6BRsSkLUq1fmfsY6TOpYzTwvwkg1/NRG85KBy3kq++A8LKQwX6lsu+aWad+2khvuXrqw==',
        license: 'ISC',
        engines: {
          node: '^20.19.0 || ^22.12.0 || >=23',
        },
      },
    },
  },
} as const;

/** SHA-256 of one file inside an installed package. */
export interface PinnedFile {
  /** Relative to the package's directory. */
  file: string;
  sha256: string;
}

/** What monomind loads or runs from one optional dependency. */
export interface CodePins {
  /** The version these hashes belong to. */
  version: string;
  /** The file ensureOptionalDependency() imports. */
  entry: PinnedFile;
  /** Native binaries the package spawns, by the platform package that
   *  carries each one. */
  binaries?: Record<string, PinnedFile>;
}

/**
 * #526: SHA-256 of the code monomind loads from the trees above, checked
 * once per process before the entry is imported and before the SDK can
 * spawn its Claude binary (optional-deps-pins.ts). assertTrustedTree tells
 * a foreign or group-writable tree from monomind's own, but not a tree
 * planted by this same user; a planted file fails here. sdk.mjs is one
 * bundle that imports only Node built-ins, so it and the platform binary
 * are all the SDK runs. @puppeteer/browsers is not pinned: it loads a whole
 * dependency tree.
 *
 * Regenerate together with the lockfile, from the registry tarballs it
 * names. For the SDK and each of its platform packages:
 *   curl -sSLO <its "resolved" URL above>
 *   echo "sha512-$(openssl dgst -sha512 -binary <tgz> | base64 -w0)"  # must equal its "integrity"
 *   tar -xOzf <tgz> package/sdk.mjs | sha256sum   # the SDK's entry
 *   tar -xOzf <tgz> package/claude | sha256sum    # package/claude.exe for win32-*
 * optional-deps-pins.test.ts checks these stay in step with the pins in
 * optional-deps.ts and with the lockfile above.
 */
export const OPTIONAL_DEPENDENCY_CODE_PINS: Partial<Record<string, CodePins>> = {
  '@anthropic-ai/claude-agent-sdk': {
    version: '0.3.226',
    entry: {
      file: 'sdk.mjs',
      sha256: '70c16db85d75e8aa46f558d35ab34138ec6f18d6e260f78e62e2cae4d24967a8',
    },
    binaries: {
      '@anthropic-ai/claude-agent-sdk-darwin-arm64': {
        file: 'claude',
        sha256: '013a1cf17df5ff1dcc189d5d6fd3fdd5f097ddc3cd41aa9992e99805574febbe',
      },
      '@anthropic-ai/claude-agent-sdk-darwin-x64': {
        file: 'claude',
        sha256: '773b095876f13ddb8336bfae202a57c62e358b1882746f1d55e3680601a32c59',
      },
      '@anthropic-ai/claude-agent-sdk-linux-arm64': {
        file: 'claude',
        sha256: 'feb715ee066d02a400c9d83941592f11c8e8fa6628c1e3c14262bc529f950498',
      },
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl': {
        file: 'claude',
        sha256: '8c58e37c14e09f0be1b5b42e1fc4f409f1124ccc584a8633b99b7e8e63d79bd0',
      },
      '@anthropic-ai/claude-agent-sdk-linux-x64': {
        file: 'claude',
        sha256: '4e9bec1177ce9690e8bd988b710ac24105e70da428dd094c5adcbbe786a55555',
      },
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl': {
        file: 'claude',
        sha256: 'd199d62f2ce2fca6138256f788ecd6157cacc40edb3b50ce22b8f974f816111a',
      },
      '@anthropic-ai/claude-agent-sdk-win32-arm64': {
        file: 'claude.exe',
        sha256: '6512422580a1f705301f7a1f6cebe436b207ed4f8a3fc23caf23295b7e8745bd',
      },
      '@anthropic-ai/claude-agent-sdk-win32-x64': {
        file: 'claude.exe',
        sha256: 'cec4e772e8237357554a8a5a86f821db9081e9fb05499bc4e5fd14b73f48708c',
      },
    },
  },
};
