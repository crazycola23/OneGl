# Browser storageState security

OneGl persists Doubao browser authentication state so scheduled monitoring does not require a manual login before every run. A Playwright storageState may contain directly reusable cookies and local-storage credentials, so production deployments should treat it like a long-lived session secret.

## Encryption contract

Set a 32-byte key through `ONEGL_STORAGE_STATE_KEY`. Supported encodings are explicit so operators cannot accidentally supply a short human password and assume it became an AES key:

```env
ONEGL_STORAGE_STATE_KEY=base64:<32 bytes encoded as base64>
# or
ONEGL_STORAGE_STATE_KEY=base64url:<32 bytes encoded as base64url>
# or
ONEGL_STORAGE_STATE_KEY=hex:<64 hex characters>
```

A convenient way to generate a key is:

```bash
printf 'base64:' && openssl rand -base64 32
```

Store the resulting value in the deployment platform's secret manager. Do not put it in `.env` files that are copied into images, source control, logs or support bundles.

For production also set:

```env
ONEGL_REQUIRE_STORAGE_STATE_ENCRYPTION=true
```

With this flag, browser startup fails before opening Doubao if the key is missing or invalid.

## File format and account binding

Encrypted state files use the existing per-account layout with an `.enc` suffix, for example:

```text
.onegl/auth/accounts/account_01.storage.json.enc
```

The payload uses AES-256-GCM with a fresh random 96-bit IV for every write. The authenticated additional data contains the format version and the Doubao account key. This means an encrypted file copied from `account_01` to `account_02` will not decrypt as account 02.

The JSON envelope stores only non-secret encryption metadata plus ciphertext:

```json
{
  "format": "onegl-storage-state",
  "version": 1,
  "algorithm": "aes-256-gcm",
  "key_id": "non-secret-key-fingerprint",
  "scope": "provider=doubao;account=account_01",
  "iv": "...",
  "tag": "...",
  "ciphertext": "..."
}
```

`key_id` is a short SHA-256 fingerprint used only for diagnostics; it cannot be used to reconstruct the key.

## Legacy plaintext migration

When `ONEGL_STORAGE_STATE_KEY` is configured and OneGl finds an existing legacy file such as:

```text
.onegl/auth/accounts/account_01.storage.json
```

it performs a one-time migration:

1. parse the existing Playwright storageState;
2. encrypt it to the `.enc` path using an atomic same-directory rename;
3. set the encrypted file mode to `0600`;
4. remove the plaintext file;
5. return the decrypted object in memory to Playwright.

If the plaintext file cannot be removed, the operation fails instead of silently declaring the migration complete.

After an encrypted file exists, removing the encryption key does **not** make OneGl fall back to plaintext mode. Loading fails closed, and saving refuses to overwrite encrypted state with a plaintext file.

## Runtime handling

Playwright no longer receives the on-disk file path when encryption is enabled. OneGl decrypts the state into an in-memory object and passes that object to `browser.newContext({ storageState })`. On save, OneGl obtains `context.storageState()` in memory and encrypts it before the write reaches persistent storage.

The decrypted object still exists in the Node.js process while the browser session is active. Encryption at rest therefore does not protect against a fully compromised running process or host.

## Key availability and multi-process deployment

Every OneGl process that reads or writes a shared auth data directory must receive the same active storage-state key. In a deployment where each worker has a separate local data directory, each worker must have access to the auth state for the accounts it executes; encryption does not change that placement requirement.

Do not store `ONEGL_STORAGE_STATE_KEY` in PostgreSQL. Recommended sources are the hosting platform's secret store, a mounted secret file transformed into the environment by the process supervisor, or a future KMS/HSM adapter.

## Key rotation

OneGl includes a re-encryption CLI so a key can be rotated without forcing every account to log in again. Perform rotation as a maintenance operation while API remote-auth writers and account-executing workers are stopped.

Inject the previous and new keys from your secret manager:

```env
ONEGL_STORAGE_STATE_OLD_KEY=base64:<previous 32-byte key>
ONEGL_STORAGE_STATE_KEY=base64:<new 32-byte key>
```

First validate every encrypted file without changing it:

```bash
npm run storage:rotate -- --dry-run
```

Then rotate in place:

```bash
npm run storage:rotate
```

The command scans the default state plus `.onegl/auth/accounts/*.storage.json.enc`, authenticates every file before starting writes, and replaces each file atomically with a new AES-GCM envelope. It never writes a plaintext backup.

The operation is restartable. If a machine stops after some files were already rewritten, rerunning the same command recognizes files already encrypted by the new key, verifies them with the new key, skips them, and continues rotating the files that still use the old key.

After the command succeeds:

1. run the dry-run again and confirm all files are accepted;
2. remove `ONEGL_STORAGE_STATE_OLD_KEY` from the deployment secret set;
3. keep only the new `ONEGL_STORAGE_STATE_KEY`;
4. restart API/workers;
5. check `/readyz` or `npm run runtime:check -- --role api` before restoring traffic.

Do not rotate while workers are actively writing storageState. A live writer holding the previous key could overwrite a newly rotated file after the rotation command completed.

## Backups and incident response

Encrypted storageState reduces the impact of a copied data directory or backup, but the encryption key and encrypted files must not be backed up together into the same unrestricted location. Backups of `.onegl` should retain normal access controls and retention limits.

If a storage-state key or decrypted auth state is suspected to be exposed, treat the corresponding Doubao sessions as compromised: invalidate/re-authenticate those sessions and issue a new encryption key. Encryption cannot revoke cookies that were already copied while decrypted.
