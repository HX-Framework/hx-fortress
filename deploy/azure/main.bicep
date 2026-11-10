// HX Fortress on Azure Container Apps.
//
// One container with a system-assigned managed identity. The identity may read
// secrets from one Key Vault, and the fortress reads its Postgres connection
// string from there by name. The fortress dials out to let.ai, so the relay
// connection needs no ingress. The administration console gets an ingress only
// when `consoleIngress` asks for one.
//
// What this template does not create: the Postgres server, and anything at
// let.ai. See README.md in this directory.
//
// This template has not been deployed from this repository: nothing here may
// create Azure resources. Check it with `az bicep build` and
// `az deployment group what-if` before the first deployment.

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

@description('Run the Sessions module. Off means the fortress stores no AI session transcripts and needs no bucket.')
param sessions bool = false

@description('Serve the administration console.')
param consoleEnabled bool = true

@description('How the console is reached. "none" gives it no ingress. "external" gives it an HTTPS ingress: public in a public environment, and reachable only from the virtual network when infrastructureSubnetId is set and internalEnvironment is true.')
@allowed([
  'none'
  'external'
])
param consoleIngress string = 'none'

@description('IP ranges (CIDR) that may reach the console ingress. Empty admits every address the ingress can be reached from.')
param consoleAllowedCidrs array = []

@description('Login of the first console account, created on the first start. Its one-time setup link is written to /data/ui/bootstrap-setup-link.txt. Leave it empty to create accounts yourself.')
param consoleBootstrapUser string = ''

@description('Resource id of a subnet for the Container Apps environment. Empty creates an environment with no virtual network.')
param infrastructureSubnetId string = ''

@description('With infrastructureSubnetId: make the environment reachable from the virtual network only.')
param internalEnvironment bool = true

@description('Storage redundancy for the file share that holds the fortress state.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
])
param storageSku string = 'Standard_ZRS'

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

var hasIngress = consoleEnabled && consoleIngress == 'external'
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
    enablePurgeProtection: true
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
    value: sessions ? 'on' : 'off'
  }
  {
    name: 'FORTRESS_SECRETS_PROVIDER'
    value: 'azure-key-vault'
  }
  {
    name: 'FORTRESS_KEY_VAULT_URL'
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

var consoleEnv = consoleEnabled
  ? [
      {
        name: 'FORTRESS_UI_ENABLE'
        value: '1'
      }
    ]
  : []

// The ingress reaches the console on the container's own address, so the
// console listens on every interface. It accepts that only together with an
// https public URL, which is also the one Host name it then answers to.
var consoleUrlEnv = hasIngress
  ? [
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

var consoleBootstrapEnv = consoleEnabled && !empty(consoleBootstrapUser)
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
    managedEnvironmentId: environment.id
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
      containers: [
        {
          name: 'hx-fortress'
          image: image
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: concat(baseEnv, enrollEnv, consoleEnv, consoleUrlEnv, consoleBootstrapEnv)
          volumeMounts: [
            {
              volumeName: 'data'
              mountPath: '/data'
            }
          ]
        }
      ]
      // Exactly one replica. A fortress holds one connection to let.ai and one
      // set of state files.
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
resource vaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, app.id, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
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
