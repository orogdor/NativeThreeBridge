# Code signing and the SmartScreen warning

When a downloaded `Launcher.exe` is opened for the first time, Windows may show "Windows protected your PC" (Microsoft Defender SmartScreen). The warning appears because the file has no download reputation yet. The file is not flagged as dangerous. **More info → Run anyway** starts it.

## What CI already does

The "Build Launcher.exe…" step signs `NativeThree-Engine.exe`, `Launcher.exe`, `Game1.exe` and `NativeThree-Updater.exe` with `signtool` (SHA-256 with an RFC 3161 timestamp) and then verifies the signatures. It does this **only** when these repository secrets exist:

| Secret | Contents |
|---|---|
| `WINDOWS_SIGN_PFX` | The code signing certificate as a .pfx, base64-encoded: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))` |
| `WINDOWS_SIGN_PASSWORD` | The .pfx password |

Without the secrets the build is unchanged and the log says "Code signing skipped". Add them under GitHub → Settings → Secrets and variables → Actions.

Certificates issued on a hardware token, such as most EV certificates and many newer OV ones, cannot be exported as a .pfx. For those, the signing step must call the CA's cloud signing tool instead, for example SSL.com eSigner, DigiCert KeyLocker or Certum SimplySign. That change is small: replace the `signtool sign /f` line.

## Options (checked November 2026)

- **Do nothing.** Users click "Run anyway" once per new file. Reputation for an unsigned file is per file hash, so it starts again with every release. Cost: free.
- **OV code signing certificate from a CA** (Certum, Sectigo, SSL.com…), issued to a private person or a company. Reputation builds up for the *certificate*, so later releases signed with the same certificate need fewer warnings. The publisher name is shown instead of "Unknown publisher". Cost: roughly tens to a couple of hundred euros a year.
- **EV certificate.** Since 2024 it no longer skips the SmartScreen check: it builds reputation the same way as OV. It is not worth the extra cost for this.
- **Microsoft Artifact Signing** (formerly Trusted Signing). About $10 a month. Public certificates are currently available only to organisations in the EU, UK, USA and Canada, and to **individual developers in the USA and Canada only**. An individual in Estonia would need a registered company to use it.
- **Microsoft Store.** No warning at all, but the app has to be packaged and distributed through the Store.

Recommendation: an OV certificate that can be exported as a .pfx (or one with a cloud signing tool), always used to sign with the same certificate. The warning will still show for the first releases and disappears as downloads build reputation.
