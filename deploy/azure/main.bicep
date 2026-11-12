// HX Fortress on Azure Container Apps.
//
// One container with a system-assigned managed identity. The identity may read
// secrets from one Key Vault, and the fortress reads its Postgres connection
// string from there by name. The fortress dials out to let.ai, so the relay
// connection needs no ingress. The administration console is served only when
// `consoleIngress` gives it an ingress.
//
// The fortress runs with Sessions off: it stores no AI session transcripts and
// needs no bucket. Sessions keeps transcripts in Amazon S3 or Google Cloud
// Storage, and this template has no settings for either.
//
// What this template does not create: the Postgres server, and anything at
// let.ai. See README.md in this directory.
//
// This template has not been compiled and not been deployed from this
// repository: nothing here may create Azure resources. Its property names were
// checked against Microsoft's resource reference for the API versions named
// below. Check it with `az bicep build` and `az deployment group what-if`
// before the first deployment.

targetScope = 'resourceGroup'

// ── Parameters ──────────────────────────────────────────────────────────────

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('A short prefix for resource names: lowercase letters and digits, starting with a letter.')
@minLength(3)
@maxLength(10)
param name string = 'hxfortress'

@description('The HX Fortress image with an explicit version tag, for example ghcr.io/hx-framework/hx-fortress:<version>.')
param image string

@description('WebSocket URL of the let.ai hub this fortress connects to.')
param cloudUrl string = 'wss://let.ai/_api/hx-gateway/vault-tunnel'

@description('The one-time enrollment token from let.ai. It is used on the first start only. Deploy again with it empty once the fortress has enrolled.')
@secure()
param enrollToken string = ''

@description('Name of the Key Vault secret that holds the Postgres connection string.')
@minLength(1)
@maxLength(64)
param databaseUrlSecretName string = 'fortress-database-url'

@description('The Postgres connection string. When given, the template stores it in the Key Vault under databaseUrlSecretName. Leave it empty to set the secret yourself.')
@secure()
param databaseUrl string = ''

@description('Object id of a person or group that may write secrets to the Key Vault (the Key Vault Secrets Officer role). The vault uses role-based access, and the owner of the resource group cannot write a secret without it. Empty assigns nothing: give the role yourself before you set a secret.')
param secretsOfficerPrincipalId string = ''

@description('The kind of the principal named in secretsOfficerPrincipalId.')
@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param secretsOfficerPrincipalType string = 'User'

@description('Keep a deleted Key Vault from being purged for 90 days. It cannot be switched off again for a vault that has it. Set it to false for a trial you mean to delete, or the vault name stays taken for 90 days.')
param purgeProtection bool = true

@description('Whether the administration console is served. "none" serves no console. "external" serves it behind an HTTPS ingress: public in a public environment, and reachable only from the virtual network when infrastructureSubnetId is set and internalEnvironment is true.')
@allowed([
  'none'
  'external'
])
param consoleIngress string = 'none'

@description('IP ranges (CIDR) that may reach the console ingress. Empty admits every address the ingress can be reached from.')
param consoleAllowedCidrs array = []

@description('Login of the first console account, created on the first start. Its one-time setup link is written to /data/ui/bootstrap-setup-link.txt and is not printed in the log. Leave it empty to create accounts yourself.')
param consoleBootstrapUser string = ''

@description('Resource id of a subnet for the Container Apps environment: /27 or larger, delegated to Microsoft.App/environments, and used by nothing else. Empty creates an environment with no virtual network of yours.')
param infrastructureSubnetId string = ''

@description('With infrastructureSubnetId: make the environment reachable from the virtual network only.')
param internalEnvironment bool = true

@description('Storage redundancy for the file share that holds the fortress state. Standard_LRS exists in every region. Standard_ZRS and Standard_GRS do not.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
])
param storageSku string = 'Standard_LRS'

// ── Names ───────────────────────────────────────────────────────────────────

var suffix = uniqueString(resourceGroup().id)
var appName = '${name}-app'
var vaultName = take('${name}-${suffix}', 24)
var storageName = take('${name}${suffix}', 24)
var shareName = 'fortress-data'

// The image runs as uid 10001 and keeps its state owner-only. An SMB share has
// no file owners of its own, so the mount states them.
var dataMountOptions = 'uid=10001,gid=10001,dir_mode=0700,file_mode=0600'

// Built-in role: Key Vault Secrets User (read secret values, nothing else).
var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

// Built-in role: Key Vault Secrets Officer (read and write secrets).
var keyVaultSecretsOfficerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

// The console is served exactly when it has an ingress. Without one nobody
// could reach it, so it is not started.
var hasIngress = consoleIngress == 'external'
var consoleUrl = hasIngress ? 'https://${appName}.${environment.properties.defaultDomain}' : ''

var ipRules = [
  for (cidr, i) in consoleAllowedCidrs: {
    name: 'allow-${i}'
    ipAddressRange: cidr
    action: 'Allow'
  }
]

// ── Logs ────────────────────────────────────────────────────────────────────

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ── State: one Azure Files share mounted at /data ───────────────────────────

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: storageSku
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Container Apps mounts a share with the account key, so shared-key access
    // has to stay on for this account.
    allowSharedKeyAccess: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    shareQuota: 5
  }
}

// ── Key Vault ───────────────────────────────────────────────────────────────

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Azure accepts true or nothing here, never false.
    enablePurgeProtection: purgeProtection ? true : null
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(databaseUrl)) {
  parent: vault
  name: databaseUrlSecretName
  properties: {
    value: databaseUrl
    contentType: 'text/plain'
  }
}

// ── Container Apps ──────────────────────────────────────────────────────────

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${name}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    // A workload profiles environment with the pay-per-use profile. Without
    // this list Azure creates the older "Consumption only" kind, which it
    // calls legacy and which has other rules for the subnet.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: empty(infrastructureSubnetId)
      ? null
      : {
          infrastructureSubnetId: infrastructureSubnetId
          internal: internalEnvironment
        }
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'fortress-data'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

var baseEnv = [
  {
    name: 'FORTRESS_CLOUD_URL'
    value: cloudUrl
  }
  {
    name: 'FORTRESS_SESSIONS'
    value: 'off'
  }
  {
    // When the connections to Postgres stay stuck after the fortress has
    // rebuilt them, exit, so that Container Apps starts the container again.
    // By itself the fortress does that only under a supervisor it recognises,
    // and Container Apps is not one of them.
    name: 'FORTRESS_STORE_EXIT_ON_WEDGE'
    value: 'on'
  }
  {
    name: 'FORTRESS_SECRETS_PROVIDER'
    value: 'azure-key-vault'
  }
  {
    name: 'FORTRESS_SECRETS_AZURE_VAULT_URL'
    value: vault.properties.vaultUri
  }
  {
    name: 'FORTRESS_DATABASE_URL_SECRET'
    value: databaseUrlSecretName
  }
]

var enrollEnv = empty(enrollToken)
  ? []
  : [
      {
        name: 'FORTRESS_ENROLL_TOKEN'
        secretRef: 'enroll-token'
      }
    ]

// The ingress reaches the console on the container's own address, so the
// console listens on every interface. It accepts that only together with an
// https public URL, which is also the one Host name it then answers to.
var consoleEnv = hasIngress
  ? [
      {
        name: 'FORTRESS_UI_ENABLE'
        value: '1'
      }
      {
        name: 'FORTRESS_UI_PUBLIC_URL'
        value: consoleUrl
      }
      {
        name: 'FORTRESS_UI_BIND'
        value: '0.0.0.0'
      }
    ]
  : []

var consoleBootstrapEnv = hasIngress && !empty(consoleBootstrapUser)
  ? [
      {
        name: 'FORTRESS_UI_BOOTSTRAP_USER'
        value: consoleBootstrapUser
      }
    ]
  : []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      // No ingress unless the console asks for one. The connection to let.ai
      // is outbound.
      ingress: hasIngress
        ? {
            external: true
            targetPort: 8788
            transport: 'http'
            allowInsecure: false
            ipSecurityRestrictions: ipRules
          }
        : null
      secrets: empty(enrollToken)
        ? []
        : [
            {
              name: 'enroll-token'
              value: enrollToken
            }
          ]
    }
    template: {
      // No health probes are declared. A fortress that stops working stops
      // itself: the container exits with the daemon, and a daemon that has
      // frozen is stopped by the process that watches it.
      //
      // With an ingress, Azure may add default probes on the ingress port,
      // which is the console's here: its documentation describes them for an
      // app that declares none. README.md says what would follow. Probes of
      // this template's own were not added, because nothing here can run one
      // to see what it does.
      containers: [
        {
          name: 'hx-fortress'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: concat(baseEnv, enrollEnv, consoleEnv, consoleBootstrapEnv)
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/data'
            }
          ]
        }
      ]
      // Exactly one replica. A fortress holds one connection to let.ai and one
      // set of state files. A new revision still starts before the old one
      // stops; README.md says how to avoid that.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
          mountOptions: dataMountOptions
        }
      ]
    }
  }
}

// The fortress reads secrets with the app's own identity. The identity exists
// only once the app does, so this assignment follows the app. A new assignment
// can take a few minutes to take effect; the fortress keeps asking for about a
// minute and then exits, and Container Apps starts it again.
//
// The name cannot hold the identity's own id, which is not known when the
// deployment starts. So after the app is deleted and created again, this
// assignment still names the old identity, and Azure refuses to change it:
// delete the old assignment first. README.md has the command.
resource vaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// A person who sets a secret in the vault needs a role of their own: the
// vault uses role-based access, and owning the resource group is not enough.
resource vaultWriteAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(secretsOfficerPrincipalId)) {
  scope: vault
  name: guid(vault.id, secretsOfficerPrincipalId, keyVaultSecretsOfficerRoleId)
  properties: {
    roleDefinitionId: keyVaultSecretsOfficerRoleId
    principalId: secretsOfficerPrincipalId
    principalType: secretsOfficerPrincipalType
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────

@description('Name of the container app.')
output containerAppName string = app.name

@description('Name of the Key Vault the fortress reads its secrets from.')
output keyVaultName string = vault.name

@description('Address of the Key Vault.')
output keyVaultUrl string = vault.properties.vaultUri

@description('Object id of the fortress managed identity.')
output principalId string = app.identity.principalId

@description('HTTPS address of the console, or empty when it has no ingress.')
output consoleUrl string = consoleUrl

@description('The default domain of the Container Apps environment. An internal environment needs a private DNS zone for this name.')
output environmentDefaultDomain string = environment.properties.defaultDomain

@description('The static IP of the Container Apps environment: where a wildcard record in that private DNS zone points.')
output environmentStaticIp string = environment.properties.staticIp
