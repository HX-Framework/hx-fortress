// Parameters for main.bicep.
//
// The image and the two secrets are read from the environment of the shell
// that runs the deployment. No secret is written in this file, and no secret
// is an argument of the `az` command. README.md shows the commands.
//
// Every other parameter of main.bicep can be set here in the same way:
//
//   param consoleIngress = 'external'
//   param consoleAllowedCidrs = ['203.0.113.0/24']

using './main.bicep'

// The HX Fortress image with a version tag.
param image = readEnvironmentVariable('FORTRESS_DEPLOY_IMAGE')

// The one-time enrollment token. Leave the variable unset on every deployment
// after the first.
param enrollToken = readEnvironmentVariable('FORTRESS_DEPLOY_ENROLL_TOKEN', '')

// The Postgres connection string. Leave the variable unset when you set the
// secret in the Key Vault yourself. A later deployment needs it only to change
// the value.
param databaseUrl = readEnvironmentVariable('FORTRESS_DEPLOY_DATABASE_URL', '')
