#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

/**
 * Does the iOS release verifier REFUSE what it should?
 *
 * `tray/ios/Releases.swift` fetches the shell for a new document from the signed
 * release channel, because starter decks are not bundled. Those bytes become an
 * executable HTML document on the reader's own disk that they will afterwards
 * trust — so an unverified download lets a network attacker choose what they
 * create, and the verification is the whole reason the fetch is acceptable at
 * all (`docs/DECISIONS.md`, 2026-08-16).
 *
 * Watching it succeed against the live server proves nothing: `return true`
 * passes that test. What has to be shown is that it says NO — to a tampered
 * payload, to a tampered signature, to a signature that is valid for a
 * DIFFERENT payload, and to a malformed envelope. Every case below is a way the
 * check could be wrong while looking right in the app.
 *
 * The fixture is a real manifest captured from bento.page. It does not go stale:
 * a signature stays valid for the bytes it covers forever, so this keeps testing
 * the same thing after the live release has moved on.
 *
 * Needs an APPLE Swift toolchain, and the reason is worth stating precisely
 * because the obvious guess is wrong: the Linux CI runner DOES have `swiftc`,
 * and `scripts/test-tray-index.mjs` really does compile and run there. What is
 * missing on Linux is CryptoKit, which is Apple-only — so this rig probes for
 * the MODULE rather than for the compiler. Probing for `swiftc` skipped nothing
 * and failed the build.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Can this machine build the thing under test at all? */
function haveCryptoKit() {
  let probe
  try {
    probe = mkdtempSync(join(tmpdir(), 'bento-cryptokit-'))
    // Foundation too — `Data` comes from there, and a probe that fails for its
    // OWN missing import would skip this rig on a perfectly capable Mac.
    writeFileSync(join(probe, 'main.swift'),
      'import CryptoKit\nimport Foundation\nprint(SHA256.hash(data: Data()).description)\n')
    execFileSync('swiftc', ['-o', join(probe, 'p'), join(probe, 'main.swift')], { stdio: 'pipe' })
    return true
  } catch {
    return false
  } finally {
    if (probe) try { rmSync(probe, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

if (!haveCryptoKit()) {
  console.log('tray releases: SKIPPED — no CryptoKit on this machine (Apple platforms only).')
  console.log('               This rig is the only proof that the release verifier REFUSES a')
  console.log('               tampered manifest, and a new document is fetched over the network')
  console.log('               and written to disk as an executable page. Run it on a Mac before')
  console.log('               touching Releases.swift.')
  process.exit(0)
}

const MAIN = `
import Foundation

// Reads one envelope per argument (as a file path) and reports whether the
// verifier accepted it. Any throw is a refusal, which is the correct answer for
// every case here except the first.
for path in CommandLine.arguments.dropFirst() {
    let raw = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    do {
        let payload = try Releases.verify(raw)
        let version = (payload["version"] as? String) ?? "?"
        print("ACCEPT \\(version)")
    } catch {
        print("REFUSE \\(error.localizedDescription)")
    }
}
`

const dir = mkdtempSync(join(tmpdir(), 'bento-releases-'))
writeFileSync(join(dir, 'main.swift'), MAIN)
const bin = join(dir, 'verifier')
try {
  execFileSync('swiftc', ['-O', '-o', bin, join(ROOT, 'tray/ios/Releases.swift'), join(dir, 'main.swift')],
    { stdio: 'pipe' })
} catch (e) {
  console.error('swiftc failed:\n' + (e.stderr?.toString() ?? e.message))
  process.exit(2)
}

const real = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/tray-release-manifest.json'), 'utf8'))

/** Flip one character of a base64 signature, keeping it decodable. */
const bendSig = (sig) => {
  const at = 10
  const c = sig[at]
  return sig.slice(0, at) + (c === 'A' ? 'B' : 'A') + sig.slice(at + 1)
}

const cases = [
  {
    name: 'the real manifest',
    expect: 'ACCEPT',
    why: 'a genuine signed release must be accepted, or nothing can be created at all',
    envelope: JSON.stringify(real),
  },
  {
    name: 'payload tampered (url swapped)',
    expect: 'REFUSE',
    why: 'THE attack: point the download at a shell an attacker controls',
    envelope: JSON.stringify({
      ...real,
      payload: real.payload.replace(/"url":"[^"]*"/, '"url":"https://evil.example/shell.html"'),
    }),
  },
  {
    name: 'payload tampered (sha256 swapped)',
    expect: 'REFUSE',
    why: 'defeats the hash check downstream by re-pinning it to attacker bytes',
    envelope: JSON.stringify({
      ...real,
      payload: real.payload.replace(/"sha256":"[0-9a-f]*"/, `"sha256":"${'0'.repeat(64)}"`),
    }),
  },
  {
    name: 'signature tampered',
    expect: 'REFUSE',
    why: 'a bent signature must not verify — catches a verifier that ignores its input',
    envelope: JSON.stringify({ ...real, sig: bendSig(real.sig) }),
  },
  {
    name: 'signature valid for a DIFFERENT payload',
    expect: 'REFUSE',
    why: 'catches verifying the wrong bytes — a real signature, the wrong message',
    envelope: JSON.stringify({ payload: JSON.stringify({ app: 'bento-slides', version: '9.9.9' }), sig: real.sig }),
  },
  {
    name: 'signature removed',
    expect: 'REFUSE',
    why: 'an unsigned manifest must never be treated as signed',
    envelope: JSON.stringify({ payload: real.payload }),
  },
  {
    name: 'empty signature',
    expect: 'REFUSE',
    why: 'the empty string is the value an absent field decodes to',
    envelope: JSON.stringify({ ...real, sig: '' }),
  },
  {
    name: 'not JSON at all',
    expect: 'REFUSE',
    why: 'a captive-portal HTML page is what a fetch returns on hotel wifi',
    envelope: '<html><body>Sign in to continue</body></html>',
  },
]

const paths = cases.map((c, i) => {
  const p = join(dir, `case-${i}.json`)
  writeFileSync(p, c.envelope)
  return p
})

const out = execFileSync(bin, paths).toString().trim().split('\n')

let failed = 0
for (const [i, c] of cases.entries()) {
  const got = (out[i] ?? '').startsWith('ACCEPT') ? 'ACCEPT' : 'REFUSE'
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.expect.padEnd(6)} ${c.name}`)
  if (!ok) {
    console.log(`       expected ${c.expect}, got: ${out[i]}`)
    console.log(`       why it matters: ${c.why}`)
  }
}

console.log(`\ntray releases: ${cases.length - failed}/${cases.length} verifier cases behaved correctly`)
if (failed) {
  console.error('\nThe release verifier does not refuse what it must. A new document is')
  console.error('fetched over the network and written to disk as an executable page —')
  console.error('this check is what makes that acceptable.')
  process.exit(1)
}
console.log('               a tampered manifest cannot produce a document')
