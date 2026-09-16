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

Version 1 currently expects the active key that created the encrypted file. Rotation should therefore be deliberate:

1. stop account-executing workers and remote-auth writers;
2. retain the old key securely until all existing state has been decrypted;
3. re-authenticate accounts under the new key, or use a dedicated re-encryption migration tool when one is introduced;
4. verify no files remain that require the old key;
5. retire the old key.

Do not simply replace the environment key while old `.enc` files remain; authenticated decryption will correctly fail.

## Backups and incident response

Encrypted storageState reduces the impact of a copied data directory or backup, but the encryption key and encrypted files must not be backed up together into the same unrestricted location. Backups of `.onegl` should retain normal access controls and retention limits.

If a storage-state key or decrypted auth state is suspected to be exposed, treat the corresponding Doubao sessions as compromised: invalidate/re-authenticate those sessions and issue a new encryption key. Encryption cannot revoke cookies that were already copied while decrypted.
