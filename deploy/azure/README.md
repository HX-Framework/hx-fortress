# HX Fortress on Azure Container Apps

`main.bicep` deploys one HX Fortress into a resource group you own:

| Resource | What it is for |
| --- | --- |
| Container Apps environment | A workload profiles environment with the pay-per-use profile. It holds this one app. |
| Container app, one replica | Runs `hx-fortress container-run`: the daemon and, when the console has an ingress, the administration console. |
| System-assigned managed identity | The only identity the fortress has in Azure. It holds one role: **Key Vault Secrets User** on the vault below. |
| Key Vault | Holds the Postgres connection string. The fortress reads it by name at start and keeps it in memory. |
| Storage account with one file share | Mounted at `/data`. Holds the enrollment credential, the pinned signing key, console accounts and the audit spool. |
| Log Analytics workspace | Receives the container's log. |

The template does not create a Postgres server, and it creates nothing at a
control plane. The fortress dials out to its control plane over `wss`, so that
connection needs no ingress. The console is served only when you give it an ingress.

The fortress runs with [Sessions off](../../README.md#sessions-on-or-off): it
stores no AI session transcripts and needs no bucket.

**This template has not been compiled and has not been deployed from this
repository.** Nothing in this repository's tests or CI creates Azure resources.
Its property names were checked against Microsoft's resource reference for the
API versions it names, and nothing more. The same holds for every command on
this page. Run the two checks under "Deploy" before your first deployment, and
make that deployment a trial in a resource group you can delete (see
"A trial deployment").

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
3. **The control plane's address and an enrollment token** for your
   organization. The control plane gives you both.
4. **An image tag.** Use a release that contains this directory. Pin a version;
   do not deploy `latest`.
5. **Azure CLI 2.53.0 or later with Bicep 0.22 or later.** The deployment reads
   its parameters from a `.bicepparam` file.
6. **The right to assign roles in the resource group.** The template gives the
   fortress its role on the vault. The Contributor role cannot do that. Owner
   can, and so can Role Based Access Control Administrator beside Contributor.

## Deploy

`main.bicepparam` reads the image, the control plane's address and the two
secrets from the environment of your shell. So neither secret is written in a
file, and neither is an argument of `az`, where other users of the machine
could read it in the process list. To set any other parameter, add a line to
your copy of `main.bicepparam`.

The template has no default for the control plane's address. A copy of
`main.bicepparam` made from an earlier version of this directory has no line
for it, and a deployment with that copy is refused. Add this line to it:

```bicep
param cloudUrl = readEnvironmentVariable('FORTRESS_DEPLOY_CLOUD_URL')
```

Check the template first. Both commands change nothing. Run them before you
read the secrets into the shell: the check then has no secret to print.

```sh
export FORTRESS_DEPLOY_IMAGE=ghcr.io/hx-framework/hx-fortress:<version>
export FORTRESS_DEPLOY_CLOUD_URL=<the control plane's address>
az bicep build --file deploy/azure/main.bicep --stdout > /dev/null
az deployment group what-if --resource-group <group> --parameters deploy/azure/main.bicepparam
```

Then read the two secrets and deploy. `read -rs` does not echo what you paste:

```sh
read -rs FORTRESS_DEPLOY_ENROLL_TOKEN && export FORTRESS_DEPLOY_ENROLL_TOKEN
read -rs FORTRESS_DEPLOY_DATABASE_URL && export FORTRESS_DEPLOY_DATABASE_URL
az deployment group create --resource-group <group> --parameters deploy/azure/main.bicepparam
unset FORTRESS_DEPLOY_ENROLL_TOKEN FORTRESS_DEPLOY_DATABASE_URL
```

### Where the connection string goes

The template stores it in the Key Vault as the secret `fortress-database-url`,
and in no other resource: it is not a setting of the container app. The
fortress reads it at start and keeps it in memory. It writes it to no file.
Its log is on the file share and quotes errors from the database driver. The
fortress removes connection strings in URL form from those errors, which is
why it refuses a secret in any other form.

To keep the connection string out of the deployment as well, leave
`FORTRESS_DEPLOY_DATABASE_URL` unset and set the secret yourself once the vault
exists:

```sh
az keyvault secret set --vault-name <vault> --name fortress-database-url --file ./database-url.txt
```

That command is a call to the vault, not to the resource group, and the vault
uses role-based access. Owning the resource group is not enough: you need the
**Key Vault Secrets Officer** role on the vault. Either let the template give
it to you, with one more line in `main.bicepparam`:

```bicep
param secretsOfficerPrincipalId = '<your object id>'
```

`az ad signed-in-user show --query id --output tsv` prints your object id. Or
give it yourself after the deployment:

```sh
az role assignment create --role "Key Vault Secrets Officer" \
  --assignee-object-id <your object id> --assignee-principal-type User \
  --scope <resource id of the vault>
```

The fortress exits when the secret is missing, and Container Apps starts it
again, so it picks the secret up within a few minutes of you adding it.

### The first start

**The first start can take a few minutes.** The managed identity is created
with the app, and its role on the vault is assigned after that and takes
effect a little later. Until then the vault answers `403`. The fortress asks
six times, ten seconds apart, then exits, and Container Apps starts it again.

### After the fortress has enrolled

The enrollment token works once, and a fortress that holds a credential ignores
it. It stays in the container app as a Container Apps secret until a deployment
leaves it out. Leave `FORTRESS_DEPLOY_ENROLL_TOKEN` unset at your next
deployment, for example the next upgrade. Export `FORTRESS_DEPLOY_IMAGE` and
`FORTRESS_DEPLOY_CLOUD_URL` again in the shell that runs it: the parameter file
reads both at every deployment. That deployment makes a new revision, so read
the next section first.

## One copy at a time

A fortress must run as one copy. Two copies would share one credential and
write the same state files.

The template keeps one replica. But Container Apps starts a new revision
before it stops the old one, so two copies run on the same share until the new
one counts as ready. A new revision is made by every deployment that changes
the container: a new image, a changed setting, the enrollment token left out.

So before each such deployment, stop the running copy:

```sh
az containerapp revision list --resource-group <group> --name <name>-app --output table
az containerapp revision deactivate --resource-group <group> --revision <active revision>
```

Then deploy. The fortress is away from its control plane between the two. If the
deployment changes nothing in the container, no new revision is made: start
the old one again with `az containerapp revision activate`.

Restart the fortress the same way, with `deactivate` and then `activate` on the
same revision.

## A trial deployment

For a trial, add this line to `main.bicepparam`:

```bicep
param purgeProtection = false
```

A deleted Key Vault stays for 90 days and keeps its name. The vault's name
comes from the resource group, so a second trial in a resource group of the
same name fails on that name. Without purge protection you can remove the
deleted vault at once:

```sh
az keyvault purge --name <vault>
```

With purge protection, which is the default and is right for a fortress you
keep, nobody can remove a deleted vault before the 90 days end. Purge
protection cannot be switched off for a vault that has it. Bring the vault back
with `az keyvault recover`, or deploy with another `name`.

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `image` | none | The HX Fortress image, with a version tag. |
| `name` | `hxfortress` | Prefix for resource names. |
| `location` | the resource group's | Azure region. |
| `cloudUrl` | none | The control plane's address. |
| `enrollToken` | empty | One-time enrollment token. First start only. |
| `databaseUrlSecretName` | `fortress-database-url` | Name of the Key Vault secret that holds the connection string. |
| `databaseUrl` | empty | When given, the template stores it under that name. |
| `secretsOfficerPrincipalId` | empty | Object id of a person or group that gets the Key Vault Secrets Officer role on the vault. |
| `secretsOfficerPrincipalType` | `User` | `User`, `Group` or `ServicePrincipal`. |
| `purgeProtection` | `true` | Keeps a deleted vault from being removed for 90 days. `false` for a trial. |
| `consoleIngress` | `none` | `external` serves the console behind an HTTPS ingress. `none` serves no console. |
| `consoleAllowedCidrs` | `[]` | IP ranges that may reach the console ingress. |
| `consoleBootstrapUser` | empty | Login of a first console account. |
| `infrastructureSubnetId` | empty | A subnet of yours for the environment: /27 or larger, delegated to `Microsoft.App/environments`, used by nothing else. |
| `internalEnvironment` | `true` | With a subnet: reachable from the virtual network only. |
| `storageSku` | `Standard_LRS` | Redundancy of the state share. `Standard_ZRS` keeps copies in three zones, in regions that have zones. |

## What the container is given

The template sets these, and nothing else that holds a credential:

| Variable | Value |
| --- | --- |
| `FORTRESS_CLOUD_URL` | the control plane's address |
| `FORTRESS_ENROLL_TOKEN` | the enrollment token, from a Container Apps secret, while a deployment passes one |
| `FORTRESS_SESSIONS` | `off` |
| `FORTRESS_STORE_EXIT_ON_WEDGE` | `on`: exit when the connections to Postgres stay stuck, so that Container Apps starts the container again |
| `FORTRESS_SECRETS_PROVIDER` | `azure-key-vault` |
| `FORTRESS_SECRETS_AZURE_VAULT_URL` | the vault's address |
| `FORTRESS_DATABASE_URL_SECRET` | the name of the secret, never its value |
| `FORTRESS_UI_ENABLE` | `1`, when the console has an ingress |
| `FORTRESS_UI_PUBLIC_URL` | the console's HTTPS address, when it has an ingress |
| `FORTRESS_UI_BIND` | `0.0.0.0`, when it has an ingress, so the ingress can reach it |
| `FORTRESS_UI_BOOTSTRAP_USER` | the login of the first console account, when you gave one and the console has an ingress |

Azure adds `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` to the container. The
fortress uses them to get a token for the vault. No client secret and no
storage key reach the container.

## Reaching the console

With `consoleIngress=none` no console is served. Use this while you only need
the connection to the control plane.

With `consoleIngress=external` the console is served at the `consoleUrl` output
over HTTPS.

- **In an environment with no virtual network of yours** that address is
  public. Set `consoleAllowedCidrs`, and turn on sign-in through your identity
  provider.
- **In an internal environment** (a subnet of yours and `internalEnvironment`
  true) the address is reachable from your virtual network only, and its name
  does not resolve until you add a private DNS zone. Name the zone as the
  `environmentDefaultDomain` output, add a wildcard `*` A record that points to
  the `environmentStaticIp` output, and link the zone to the virtual network.
  The template does not create this zone.

With `consoleBootstrapUser`, the first account's one-time setup link is left in
`/data/ui/bootstrap-setup-link.txt`, which you read from the container's shell
(see below). The link is not printed in the log: the log names the file. It
works for 24 hours.

### Console settings

Console settings are made with the fortress's own commands, inside the
container. Open a shell there:

```sh
az containerapp exec --resource-group <group> --name <name>-app
```

`hx-fortress ui config` shows the settings. A command that changes one, such as
`hx-fortress ui config set <key> <value>`, is written to the audit trail.

### Sign-in through Microsoft Entra ID

It is set up the same way; see "Sign in with your identity provider" in the
main README. Register `<consoleUrl>/oidc/callback` as a **Web** redirect URI of
your app registration. Keep the application's client secret in the same Key
Vault. Setting it needs the Key Vault Secrets Officer role, as above:

```sh
az keyvault secret set --vault-name <vault> --name oidc-client-secret --file ./client-secret.txt
```

Then give the console its name, in the container's shell:

```sh
hx-fortress ui oidc set clientSecretName oidc-client-secret
```

### The caller's address

Behind the ingress, every request reaches the console from the ingress's own
address. Until the console is told to trust that address, it does not read
`X-Forwarded-For`, and every caller shares one sign-in limit and one lockout
counter: one person's failed sign-ins lock out everybody.

Find the address first. Sign in once and open your own sign-in in the console's
Audit page: its `remote` field is the address the console saw. With no trusted
proxy set, that is the ingress. Then name the range it belongs to, in the
container's shell:

```sh
hx-fortress ui config set trustedProxies <range>
```

This repository has not observed which range that is. In a workload profiles
environment Azure reserves `100.100.0.0/17`, `100.100.128.0/19`,
`100.100.160.0/19` and `100.100.192.0/19` for its own parts.

The template makes this environment for the fortress alone. Keep it that way:
the console believes the header from every address in the range you name.

## Operating it

- **Logs:** `az containerapp logs show --resource-group <group> --name <name>-app --follow`,
  or the Log Analytics workspace.
- **Status:** `hx-fortress status`, in the container's shell.
- **Rotate the database password:** set a new version of the secret in the Key
  Vault, then restart the fortress as "One copy at a time" says. The daemon
  reads the connection string when it starts.
- **Upgrade:** set the new image tag and deploy, as "One copy at a time" says.
- **Exactly one replica.** Do not raise `maxReplicas`.
- **A fortress that is stuck stops itself.** The container exits with the
  daemon, and a daemon that has frozen is stopped by the process that watches
  it.
  With `FORTRESS_STORE_EXIT_ON_WEDGE=on` the daemon also exits when its
  connections to Postgres stay stuck after it has rebuilt them. It does not
  exit when they have not worked once since the start, because a restart does
  not cure a wrong address. Container Apps starts the container again each
  time.
- **Health probes.** The template declares none: the fortress stops itself as
  above. With `consoleIngress=none` Azure then runs none. With
  `consoleIngress=external` Azure may add default ones. Its documentation
  describes them for an app that has an ingress and declares no probes of its
  own: they only test that the ingress port accepts a connection, and for this
  template that port is the console's. Whether they apply to an app deployed
  from a template was not checked from this repository. If they do, two things
  follow:
  - A new revision counts as ready once the console's port answers, and the
    old revision stops only then. This is one more reason to stop the running
    copy first, as "One copy at a time" says.
  - A console that stays down fails the liveness probe, and Azure restarts the
    container, the daemon included. The fortress restarts its own console
    after a crash, waiting up to 30 seconds between tries.
- **If you delete the container app and deploy again,** delete the fortress's
  old role assignment on the vault first. The new app has a new identity, the
  assignment keeps its old name, and Azure does not change who an existing
  assignment is for, so the deployment fails until the old one is gone:

  ```sh
  az role assignment list --scope <resource id of the vault> --role "Key Vault Secrets User" --output table
  az role assignment delete --ids <id of the old assignment>
  ```

## What to know about the state share

- **It is an SMB share, not a local disk.** The fortress was written for a
  local disk and has not been run on Azure Files from this repository. It
  replaces its status file every 5 seconds and its metrics file every 10
  seconds by writing a new file and renaming it over the old one, and it
  appends each log line to a file on the share. On a share each of these is a
  call over the network.
- The share is mounted with `uid=10001,gid=10001,dir_mode=0700,file_mode=0600`.
  The image runs as uid 10001 and keeps its files owner-only. An SMB share has
  no owners of its own and ignores a change of mode, so the mount states them.
- Container Apps mounts the share with the storage account key, so shared-key
  access stays on for that account. The key is held by the Container Apps
  environment, not by the container. Container Apps can also mount an SMB share
  with the environment's managed identity instead of the key. Azure calls that
  a preview at the time of writing, so this template uses the key.
- Deleting the share deletes the enrollment credential. The fortress then
  needs a new enrollment token.

## Not covered by this template

- A Postgres server, its firewall rules, or private networking to it.
- A private endpoint or firewall for the Key Vault or the storage account. If
  you add a Key Vault firewall, admit the Container Apps environment's subnet.
- The private DNS zone of an internal environment.
- Pulling the image from a private registry.
- An identity that exists before the app (a user-assigned managed identity).
  With one, the fortress could read the vault from its first second, and
  deleting the app would leave the role assignment valid. The fortress can use
  one, through `FORTRESS_SECRETS_AZURE_CLIENT_ID`. This template does not make one.
- The Sessions module. Sessions stores transcripts in Amazon S3 or Google Cloud
  Storage and has no Azure Blob Storage backend. This template always runs the
  fortress with Sessions off and has no settings for a bucket.
