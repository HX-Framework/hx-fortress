# HX Fortress on Azure Container Apps

`main.bicep` deploys one HX Fortress into a resource group you own:

| Resource | What it is for |
| --- | --- |
| Container app, one replica | Runs `hx-fortress container-run`: the daemon and, when enabled, the administration console. |
| System-assigned managed identity | The only identity the fortress has in Azure. It holds one role: **Key Vault Secrets User** on the vault below. |
| Key Vault | Holds the Postgres connection string. The fortress reads it by name at start and keeps it in memory. |
| Storage account with one file share | Mounted at `/data`. Holds the enrollment credential, the pinned signing key, console accounts and the audit spool. |
| Log Analytics workspace | Receives the container's log. |

The template does not create a Postgres server, and it creates nothing at
let.ai. The fortress dials out to let.ai over `wss`, so the relay connection
needs no ingress. The console gets an ingress only when you ask for one.

**This template has not been deployed from this repository.** Nothing in this
repository's tests or CI creates Azure resources, and the template was not run
through `az bicep build` here. Run the two checks under "Deploy" before your
first deployment, and treat the first one as a trial in a resource group you
can delete.

## Before you deploy

1. **A Postgres database** that the container can reach. The fortress's
   migrations create four extensions: `pgcrypto`, `pg_trgm`, `btree_gin` and
   `vector`. On Azure Database for PostgreSQL flexible server an extension can
   be created only after it is allowed in the server parameter
   `azure.extensions`, so allow all four before the first start.
2. **The connection string**, in URL form, with TLS required:
   `postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<database>?sslmode=require`
   It must be a `postgres://` or `postgresql://` URL. The fortress refuses a
   secret in any other form, and does not repeat it.
3. **An enrollment token** for your organization, from let.ai.
4. **An image tag.** Use a release that contains this directory. Pin a version;
   do not deploy `latest`.

## Deploy

Check the template first. Both commands change nothing:

```sh
az bicep build --file deploy/azure/main.bicep --stdout > /dev/null
az deployment group what-if --resource-group <group> --template-file deploy/azure/main.bicep \
  --parameters image=ghcr.io/hx-framework/hx-fortress:<version>
```

Then deploy. Both secrets are read from your shell and are not echoed:

```sh
read -rs ENROLL_TOKEN
read -rs DATABASE_URL
az deployment group create --resource-group <group> --template-file deploy/azure/main.bicep \
  --parameters image=ghcr.io/hx-framework/hx-fortress:<version> \
               enrollToken="$ENROLL_TOKEN" databaseUrl="$DATABASE_URL"
```

`databaseUrl` is stored in the Key Vault as the secret `fortress-database-url`
and nowhere else: it is not in the container app's settings and not on the file
share. To keep it out of the deployment as well, leave `databaseUrl` empty and
set the secret yourself once the vault exists:

```sh
az keyvault secret set --vault-name <vault> --name fortress-database-url --file ./database-url.txt
```

The fortress exits when the secret is missing, and Container Apps starts it
again, so it picks the secret up within a few minutes of you adding it.

**The first start can take a few minutes.** The managed identity is created
with the app, and its role on the vault takes effect a little later. Until then
the vault answers `403`. The fortress asks again for about a minute, then exits,
and Container Apps restarts it.

**After the fortress has enrolled, deploy once more with `enrollToken` empty.**
The token works once. A fortress that holds a credential ignores it, and
removing it takes it out of the container app's settings.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `image` | none | The HX Fortress image, with a version tag. |
| `name` | `hxfortress` | Prefix for resource names. |
| `location` | the resource group's | Azure region. |
| `cloudUrl` | `wss://let.ai/_api/hx-gateway/vault-tunnel` | The let.ai hub. |
| `enrollToken` | empty | One-time enrollment token. First start only. |
| `databaseUrlSecretName` | `fortress-database-url` | Name of the Key Vault secret that holds the connection string. |
| `databaseUrl` | empty | When given, the template stores it under that name. |
| `sessions` | `false` | Run the Sessions module. Off means no AI session transcripts are stored and no bucket is needed. |
| `consoleEnabled` | `true` | Serve the administration console. |
| `consoleIngress` | `none` | `external` gives the console an HTTPS ingress. |
| `consoleAllowedCidrs` | `[]` | IP ranges that may reach the console ingress. |
| `consoleBootstrapUser` | empty | Login of a first console account. |
| `infrastructureSubnetId` | empty | Put the environment in your virtual network. |
| `internalEnvironment` | `true` | With a subnet: reachable from the virtual network only. |
| `storageSku` | `Standard_ZRS` | Redundancy of the state share. |

## What the container is given

The template sets these, and nothing else that holds a credential:

| Variable | Value |
| --- | --- |
| `FORTRESS_CLOUD_URL` | the hub |
| `FORTRESS_ENROLL_TOKEN` | the enrollment token, from a Container Apps secret, on the first deployment only |
| `FORTRESS_SESSIONS` | `off` unless `sessions` is true |
| `FORTRESS_SECRETS_PROVIDER` | `azure-key-vault` |
| `FORTRESS_KEY_VAULT_URL` | the vault's address |
| `FORTRESS_DATABASE_URL_SECRET` | the name of the secret, never its value |
| `FORTRESS_UI_ENABLE` | `1` when the console is enabled |
| `FORTRESS_UI_PUBLIC_URL` | the console's HTTPS address, when it has an ingress |
| `FORTRESS_UI_BIND` | `0.0.0.0`, when it has an ingress, so the ingress can reach it |
| `FORTRESS_UI_BOOTSTRAP_USER` | the login of the first console account, when you gave one |

Azure adds `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` to the container. The
fortress uses them to get a token for the vault. No client secret and no
storage key reach the container.

## Reaching the console

With `consoleIngress=none` the console has no address. Use this while you only
need the relay connection.

With `consoleIngress=external` the console is served at the `consoleUrl` output
over HTTPS. In an environment with no virtual network that address is public:
set `consoleAllowedCidrs`, and turn on sign-in through your identity provider.
In an internal environment the same address resolves only inside your virtual
network.

Console settings are made with the fortress's own commands, run inside the
container. Each one is written to the audit trail:

```sh
az containerapp exec --resource-group <group> --name <name>-app --command "hx-fortress ui config"
```

Sign-in through Microsoft Entra ID is set up the same way; see "Sign in with
your identity provider" in the main README. Register
`<consoleUrl>/oidc/callback` as a **Web** redirect URI of your app
registration. Keep the application's client secret in the same Key Vault and
give the console its name:

```sh
az keyvault secret set --vault-name <vault> --name oidc-client-secret --file ./client-secret.txt
az containerapp exec ... --command "hx-fortress ui oidc set clientSecretName oidc-client-secret"
```

Behind the ingress every request reaches the console from the ingress's own
address. Tell the console to read the caller's address from `X-Forwarded-For`
by naming the environment's subnet as a trusted proxy:

```sh
az containerapp exec ... --command "hx-fortress ui config set trustedProxies <subnet-cidr>"
```

## Operating it

- **Logs:** `az containerapp logs show --resource-group <group> --name <name>-app --follow`,
  or the Log Analytics workspace.
- **Status:** `az containerapp exec ... --command "hx-fortress status"`.
- **Rotate the database password:** set a new version of the secret in the Key
  Vault, then restart the revision. The daemon reads the connection string
  when it starts.
- **Upgrade:** deploy again with a new `image` tag. Container Apps starts the
  new revision before it stops the old one, so two copies run for a short time.
  To avoid the overlap, deactivate the running revision first and then deploy.
- **Exactly one replica.** A fortress holds one connection to let.ai and one
  set of state files. Do not raise `maxReplicas`.

## What to know about the state share

- The share is mounted with `uid=10001,gid=10001,dir_mode=0700,file_mode=0600`.
  The image runs as uid 10001 and keeps its files owner-only; an SMB share has
  no owners of its own, so the mount states them.
- Container Apps mounts a share with the storage account key, so shared-key
  access stays on for that account. The key is held by the Container Apps
  environment, not by the container.
- Deleting the share deletes the enrollment credential. The fortress then
  needs a new enrollment token.

## Not covered by this template

- A Postgres server, its firewall rules, or private networking to it.
- A private endpoint or firewall for the Key Vault or the storage account. If
  you add a Key Vault firewall, admit the Container Apps environment's subnet.
- Pulling the image from a private registry.
- The Sessions module's object storage. Sessions stores transcripts in Amazon
  S3 or Google Cloud Storage, and has no Azure Blob Storage backend. Set
  `sessions` to true only after you have added the bucket settings from the
  main README to the container app yourself.
