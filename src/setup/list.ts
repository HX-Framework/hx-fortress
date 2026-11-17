// The setup's list: the questions HX Fortress asks, in order.
//
// ONE list, and every way to answer draws from it. `hx-fortress install` asks
// it on an engineer's own computer, before anything exists, and makes
// HX Fortress somewhere else. `hx-fortress setup` asks it on the machine that
// runs HX Fortress. The console's Settings page shows part of it again. Each
// of the three has a terminal, a browser page or a settings file in front of
// it, and none of them holds a question, an option or a word of its own. A
// thing that is added here shows in all of them.
//
// A QUESTION IS ASKED WHERE IT CAN BE ANSWERED. `asked` on a step says which
// of the three ways ask it. Where HX Fortress runs is asked by the install
// alone: on the machine itself it is a fact. Whether the control plane is
// connected and where a copy of the audit trail goes are asked by Settings
// alone. A settings file may still give any of them.
//
// THE PLACE DECIDES WHICH OPTIONS EXIST. An option with `places` is offered
// only where HX Fortress runs in one of them: a cloud's own key store in that
// cloud, a certificate the cloud issues in a cloud. `here` is the place of a
// setup that runs on the machine itself.
//
// EVERY OPTION HAS AN ID, and the id is what a settings file holds. An option
// whose code is not in this build yet keeps its id here with `built: false`:
// it is not shown, and a settings file that names it is refused in plain
// words. To switch one on, set `built: true` and add its check under the same
// id in `checks.ts`. A test fails while the two disagree.
//
// WORDS IN BRACES are filled in from the place and the other answers when the
// list is shown: `{cloud}` is the short name of the chosen cloud, `{keys}` the
// key store that was chosen. `phrase` does it, and nothing else does.
//
// Pure data, with no imports: the console's pages read this file as it is.

/** The questions, by the key each one has in a settings file. */
export const STEP_IDS = [
  "where",
  "organization",
  "keys",
  "address",
  "signIn",
  "modules",
  "data",
  "model",
  "network",
  "updates",
  "controlPlane",
  "auditTrail",
] as const;

export type StepId = (typeof STEP_IDS)[number];

/** The three ways the list is asked. */
export type Way = "install" | "setup" | "settings";

/** Where HX Fortress can run. `here` is the machine a setup runs on. */
export const PLACE_IDS = ["azure", "aws", "google-cloud", "docker", "here"] as const;

export type PlaceId = (typeof PLACE_IDS)[number];

/** The places the install offers, in the order it shows them. */
export const INSTALL_PLACES: readonly PlaceId[] = ["azure", "aws", "google-cloud", "docker"];

/** The places that are a cloud account. */
export const CLOUD_PLACES: readonly PlaceId[] = ["azure", "aws", "google-cloud"];

export interface PlaceInfo {
  id: PlaceId;
  /** What a person reads on the first page. */
  name: string;
  /** The name a sentence uses: "Azure". */
  short: string;
  /** One line under the name, for a place that needs no sign-in. */
  detail?: string;
  /** What runs HX Fortress there. */
  compute: string;
  /** The command that signs this computer in to the place. */
  signInCommand?: string;
  regions: readonly { id: string; name: string }[];
  /** The place's own services. `keys` and `files` are option ids of the
   *  questions that choose them. */
  keys?: string;
  postgres?: string;
  files?: string;
}

export const PLACES: readonly PlaceInfo[] = [
  {
    id: "azure",
    name: "Microsoft Azure",
    short: "Azure",
    compute: "Azure Container Apps",
    signInCommand: "az login",
    regions: [
      { id: "eastus2", name: "East US 2" },
      { id: "westeurope", name: "West Europe" },
      { id: "uksouth", name: "UK South" },
    ],
    keys: "azure-key-vault",
    postgres: "Azure Database for PostgreSQL",
    files: "azure-blob",
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    short: "AWS",
    compute: "AWS Fargate",
    signInCommand: "aws sso login",
    regions: [
      { id: "us-east-1", name: "us-east-1" },
      { id: "us-west-2", name: "us-west-2" },
      { id: "eu-west-1", name: "eu-west-1" },
    ],
    keys: "aws-secrets-manager",
    postgres: "Amazon RDS for PostgreSQL",
    files: "amazon-s3",
  },
  {
    id: "google-cloud",
    name: "Google Cloud",
    short: "Google Cloud",
    compute: "Cloud Run",
    signInCommand: "gcloud auth login",
    regions: [
      { id: "us-east4", name: "us-east4" },
      { id: "us-central1", name: "us-central1" },
      { id: "europe-west1", name: "europe-west1" },
    ],
    keys: "google-secret-manager",
    postgres: "Cloud SQL for PostgreSQL",
    files: "google-cloud-storage",
  },
  {
    id: "docker",
    name: "A machine of your own, with Docker",
    short: "your machine",
    detail: "HX Fortress starts there in containers, over your own SSH access.",
    compute: "Docker",
    regions: [],
  },
  {
    id: "here",
    name: "This machine",
    short: "this machine",
    compute: "This machine",
    regions: [],
  },
];

export function placeInfo(id: string): PlaceInfo {
  return PLACES.find((place) => place.id === id) ?? (PLACES[PLACES.length - 1] as PlaceInfo);
}

export function isPlaceId(value: string): value is PlaceId {
  return (PLACE_IDS as readonly string[]).includes(value);
}

export function isCloudPlace(id: string): boolean {
  return (CLOUD_PLACES as readonly string[]).includes(id);
}

/** What a field holds. `key` is a key: its NAME in the answers, and in the
 *  install a value a person may type, which is kept apart from the answers.
 *  `list` is names separated by commas. */
export type FieldKind = "text" | "key" | "list";

/** A condition on another answer: this block or field shows only while the
 *  answer at `path` is `is` (or one of them). */
export interface When {
  path: string;
  is: string | readonly string[];
}

export interface SetupField {
  /** Where the answer is, as a dotted path into the answers. */
  path: string;
  label: string;
  kind: FieldKind;
  /** Shown in the monospace face: addresses, names, ids. */
  mono?: boolean;
  /** May be left empty. */
  optional?: boolean;
  /** An example of the shape, shown while the field is empty. */
  example?: string;
  /** A closed set of values: the field is drawn as a value with a menu. */
  options?: readonly { id: string; name: string; built?: boolean }[];
  /** A few words at the field's right edge. */
  tag?: string;
  /** Asked only in these ways. Left out: in every way its step is asked. */
  ways?: readonly Way[];
  /** Asked only while another answer holds. */
  when?: When;
  /** For a key: the name it gets in the key store when a person types the
   *  key itself. */
  typedAs?: string;
}

export interface SetupOption {
  id: string;
  /** What a person reads. */
  name: string;
  /** One line under the name. */
  detail?: string;
  /** Shown at the right edge. */
  meta?: string;
  /** False: the id is pinned, the option is hidden, and a file that names it
   *  is refused. */
  built: boolean;
  /** Offered only where HX Fortress runs in one of these places. Left out:
   *  everywhere. */
  places?: readonly PlaceId[];
  /** Other words for a setup on the machine itself. */
  here?: { name?: string; detail?: string };
  /** Asked while this option is the chosen one. */
  fields?: readonly SetupField[];
}

interface BlockScope {
  when?: When;
  /** Shown only in these ways. */
  ways?: readonly Way[];
  /** Shown only where HX Fortress runs in one of these places. */
  places?: readonly PlaceId[];
}

export type FactSource = "host" | "install" | "files" | "updates" | "auditTrail" | "controlPlane" | "thisInstall";

export type SetupBlock =
  /** One or more fields under an optional label. `draw` says how a page
   *  draws them: left out, one field on a line with its label beside it;
   *  `two-by-two`, two fields on a line with each label over its field, for
   *  a few short fields that would otherwise reach the page's foot. Such a
   *  block holds only plain text and list fields, with no condition, no
   *  options and no tag: a test holds the list to it. A terminal asks the
   *  fields one by one either way. */
  | ({ kind: "fields"; label?: string; fields: readonly SetupField[]; draw?: "two-by-two" } & BlockScope)
  /** One answer from a list of options. `draw` says how: a list with a line
   *  for each option, tiles side by side, or a value with a menu. */
  | ({
      kind: "choice";
      label?: string;
      path: string;
      options: readonly SetupOption[];
      draw?: "list" | "tiles" | "menu";
      /** Asked only while a module that is on needs it. Otherwise one line
       *  says why it is not asked. */
      neededBy?: { need: "files"; idle: string };
    } & BlockScope)
  /** One yes or no, drawn as a checkbox. The answer at `path` is `on` or
   *  `off`, two option ids. `fields` are asked while it is `on`. */
  | ({
      kind: "switch";
      path: string;
      on: string;
      off: string;
      label: string;
      detail?: string;
      /** The line under the label while the answer is `off`. */
      detailOff?: string;
      built: boolean;
      fields?: readonly SetupField[];
    } & BlockScope)
  /** One switch for each module of this build. */
  | ({ kind: "modules" } & BlockScope)
  /** Things the setup found and does not ask. */
  | ({ kind: "facts"; label?: string; source: FactSource } & BlockScope)
  /** The addresses HX Fortress calls, worked out from the other answers. */
  | ({ kind: "reach" } & BlockScope)
  /** The one-time id that connects HX Fortress to a control plane. */
  | ({ kind: "connect" } & BlockScope)
  /** One plain sentence. */
  | ({ kind: "note"; text: string } & BlockScope);

export interface SetupStep {
  id: StepId;
  /** One or two words: the step's name in the strip and in Settings. */
  name: string;
  question: string;
  /** The ways that ask this step. */
  asked: readonly Way[];
  blocks: readonly SetupBlock[];
}

/** The option id that means "none" where a question can be answered with
 *  nothing. A settings file writes `false` for it. */
export const NONE = "none";

const EVERY_WAY: readonly Way[] = ["install", "setup", "settings"];
const BEFORE_IT_RUNS: readonly Way[] = ["install", "setup"];

/** The regions of one place, as the options of the Region field. */
function regionsOf(place: PlaceId): { id: string; name: string }[] {
  return placeInfo(place).regions.map((region) => ({ id: region.id, name: region.name }));
}

export const SETUP_LIST: readonly SetupStep[] = [
  {
    id: "where",
    name: "Where",
    question: "Where will HX Fortress run?",
    asked: ["install"],
    blocks: [
      {
        kind: "choice",
        path: "where.place",
        options: [
          {
            id: "azure",
            name: "Microsoft Azure",
            built: true,
            fields: [{ path: "where.region", label: "Region", kind: "text", options: regionsOf("azure") }],
          },
          {
            id: "aws",
            name: "Amazon Web Services",
            built: true,
            fields: [{ path: "where.region", label: "Region", kind: "text", options: regionsOf("aws") }],
          },
          {
            id: "google-cloud",
            name: "Google Cloud",
            built: true,
            fields: [{ path: "where.region", label: "Region", kind: "text", options: regionsOf("google-cloud") }],
          },
          {
            id: "docker",
            name: "A machine of your own, with Docker",
            detail: "HX Fortress starts there in containers, over your own SSH access.",
            built: true,
            fields: [
              {
                path: "where.ssh",
                label: "SSH address",
                kind: "text",
                mono: true,
                example: "marta@hx-fortress-vm.northstar.example",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "organization",
    name: "Organization",
    question: "Who runs this HX Fortress?",
    asked: BEFORE_IT_RUNS,
    blocks: [
      {
        kind: "fields",
        fields: [
          { path: "organization.name", label: "Organization", kind: "text", example: "Northstar" },
          {
            path: "organization.firstAdministrator",
            label: "First administrator",
            kind: "text",
            mono: true,
            example: "marta.lindqvist@northstar.example",
          },
        ],
      },
      { kind: "facts", label: "This install", source: "install", ways: ["install"] },
      { kind: "facts", label: "This host", source: "host", ways: ["setup"] },
    ],
  },
  {
    id: "keys",
    name: "Keys",
    question: "Where are keys kept?",
    asked: BEFORE_IT_RUNS,
    blocks: [
      {
        kind: "choice",
        path: "keys.store",
        options: [
          {
            id: "azure-key-vault",
            name: "Azure Key Vault",
            detail: "Read with HX Fortress's own Azure identity.",
            built: true,
            places: ["azure", "here"],
            fields: [
              {
                path: "keys.vault",
                label: "New vault",
                kind: "text",
                mono: true,
                example: "northstar-hx-fortress",
                ways: ["install"],
              },
              {
                path: "keys.address",
                label: "Vault address",
                kind: "text",
                mono: true,
                example: "https://northstar-hx-fortress.vault.azure.net",
                ways: ["setup"],
              },
              {
                path: "keys.clientId",
                label: "Identity, by client ID",
                kind: "text",
                mono: true,
                optional: true,
                ways: ["setup"],
              },
            ],
          },
          {
            id: "aws-secrets-manager",
            name: "AWS Secrets Manager",
            detail: "Read with HX Fortress's own AWS identity.",
            built: true,
            places: ["aws", "here"],
            fields: [
              { path: "keys.region", label: "Region", kind: "text", mono: true, example: "us-east-1", ways: ["setup"] },
            ],
          },
          {
            id: "google-secret-manager",
            name: "Google Secret Manager",
            detail: "Read with HX Fortress's own Google Cloud identity.",
            built: true,
            places: ["google-cloud", "here"],
            fields: [
              {
                path: "keys.project",
                label: "Project",
                kind: "text",
                mono: true,
                example: "northstar-hx-fortress",
                ways: ["setup"],
              },
            ],
          },
          {
            id: "env",
            name: "Environment variables",
            detail: "Read from this container's own settings.",
            here: { detail: "Read from this host's own settings." },
            built: true,
          },
          {
            id: "file",
            name: "A folder of files",
            detail: "Docker secrets, or HashiCorp Vault through its agent.",
            built: true,
            fields: [
              {
                path: "keys.folder",
                label: "Folder",
                kind: "text",
                mono: true,
                // Left empty, it is the folder `secrets` under HX Fortress's own.
                optional: true,
                example: "/run/secrets",
              },
            ],
          },
        ],
      },
      { kind: "note", text: "A key you type in setup is kept here, and nowhere else.", ways: ["install"] },
      { kind: "note", text: "Setup asks for the name of a key. It never asks for the key.", ways: ["setup"] },
    ],
  },
  {
    id: "address",
    name: "Address",
    question: "Where do your people reach HX Fortress?",
    asked: BEFORE_IT_RUNS,
    blocks: [
      {
        kind: "fields",
        fields: [
          {
            path: "address.hostname",
            label: "Address",
            kind: "text",
            mono: true,
            example: "hx.northstar.example",
          },
        ],
        ways: ["install"],
      },
      {
        kind: "fields",
        fields: [
          {
            path: "address.hostname",
            label: "Address",
            kind: "text",
            mono: true,
            // Left empty, the console answers on this machine only.
            optional: true,
            example: "hx.northstar.example",
          },
        ],
        ways: ["setup"],
      },
      {
        kind: "choice",
        label: "SSL certificate",
        path: "address.certificate",
        options: [
          {
            id: "cloud-issued",
            name: "Have {cloud} issue a new one",
            meta: "Automatic",
            built: true,
            places: CLOUD_PLACES,
          },
          {
            id: "own",
            name: "Your own SSL certificate",
            built: true,
            places: INSTALL_PLACES,
            fields: [
              {
                path: "address.certificateName",
                label: "Certificate, by name",
                kind: "key",
                tag: "From {keys}",
                example: "hx-fortress-cert",
              },
            ],
          },
          { id: NONE, name: "None. A proxy or load balancer in front holds it", built: true },
        ],
      },
    ],
  },
  {
    id: "signIn",
    name: "Sign-in",
    question: "How do people sign in?",
    asked: EVERY_WAY,
    blocks: [
      {
        kind: "choice",
        path: "signIn.provider",
        options: [
          {
            id: "local",
            name: "Accounts on this HX Fortress",
            detail: "Each person sets a password from a one-time link.",
            built: true,
          },
          {
            id: "openid-connect",
            name: "Your identity provider",
            detail: "Okta, Microsoft Entra ID, Google, Keycloak or any OpenID Connect provider.",
            built: true,
            fields: [
              {
                path: "signIn.issuer",
                label: "Issuer address",
                kind: "text",
                mono: true,
                example: "https://login.northstar.example",
              },
              { path: "signIn.clientId", label: "Client ID", kind: "text", mono: true, example: "hx-fortress" },
              {
                path: "signIn.clientSecret",
                label: "Client secret",
                kind: "key",
                optional: true,
                example: "sign-in-client-secret",
                typedAs: "sign-in-client-secret",
              },
            ],
          },
        ],
      },
      {
        kind: "fields",
        label: "A role for each group",
        // Four short fields. One on a line each, they reach the page's foot.
        draw: "two-by-two",
        when: { path: "signIn.provider", is: "openid-connect" },
        fields: [
          {
            path: "signIn.administratorGroups",
            label: "Administrators",
            kind: "list",
            mono: true,
            example: "hx-fortress-admins",
          },
          {
            path: "signIn.operatorGroups",
            label: "Operators",
            kind: "list",
            mono: true,
            optional: true,
            example: "data-team",
          },
          {
            path: "signIn.readonlyGroups",
            label: "Auditors, read only",
            kind: "list",
            mono: true,
            optional: true,
            example: "auditors",
          },
          // Viewers see rows in Secure Data Islands, change nothing, and open
          // nothing in the console.
          {
            path: "signIn.viewerGroups",
            label: "Viewers, see rows only",
            kind: "list",
            mono: true,
            optional: true,
            example: "data-viewers",
          },
        ],
      },
    ],
  },
  {
    id: "modules",
    name: "Modules",
    question: "What does this HX Fortress do?",
    asked: EVERY_WAY,
    blocks: [{ kind: "modules" }],
  },
  {
    id: "data",
    name: "Database",
    question: "Which database does HX Fortress use?",
    asked: BEFORE_IT_RUNS,
    blocks: [
      {
        kind: "choice",
        path: "data.database.store",
        options: [
          {
            id: "managed",
            name: "Create a managed Postgres in {cloud}",
            detail: "{postgres}. Made with HX Fortress, and reached only by it.",
            built: true,
            places: CLOUD_PLACES,
          },
          {
            id: "beside",
            name: "Install Postgres next to HX Fortress",
            detail: "A second container, with its data on the same disk.",
            here: { name: "Postgres on this disk", detail: "Started and stopped by HX Fortress." },
            built: true,
          },
          {
            id: "existing",
            name: "Connect to an existing Postgres",
            detail: "One you already run.",
            built: true,
            fields: [
              {
                path: "data.database.address",
                label: "Connection string",
                kind: "key",
                example: "database-address",
                typedAs: "database-address",
              },
            ],
          },
        ],
      },
      // In a cloud the session files go to that cloud's own file store, made
      // with HX Fortress. Nothing is asked: one line says where they go.
      { kind: "facts", source: "files", ways: ["install"], places: CLOUD_PLACES },
      {
        kind: "choice",
        label: "Files",
        path: "data.files.store",
        draw: "menu",
        neededBy: { need: "files", idle: "No module that is on keeps files" },
        ways: ["setup"],
        options: [
          { id: "this-disk", name: "This disk", built: false },
          {
            id: "s3-compatible",
            name: "S3-compatible storage",
            detail: "Read with this host's own S3 credentials",
            built: true,
            fields: [
              {
                path: "data.files.address",
                label: "Address",
                kind: "text",
                mono: true,
                example: "https://minio.northstar.example",
              },
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-hx-fortress" },
              { path: "data.files.region", label: "Region", kind: "text", mono: true, optional: true },
            ],
          },
          {
            id: "amazon-s3",
            name: "Amazon S3",
            detail: "Read with this host's own AWS role",
            built: true,
            fields: [
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-hx-fortress" },
              { path: "data.files.region", label: "Region", kind: "text", mono: true, example: "us-east-1" },
            ],
          },
          {
            id: "azure-blob",
            name: "Azure Blob Storage",
            detail: "Read with this host's own Azure identity",
            built: false,
            fields: [
              { path: "data.files.account", label: "Storage account", kind: "text", mono: true },
              { path: "data.files.container", label: "Container", kind: "text", mono: true },
            ],
          },
          {
            id: "google-cloud-storage",
            name: "Google Cloud Storage",
            detail: "Read with this host's own Google identity",
            built: true,
            fields: [
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-hx-fortress" },
              { path: "data.files.project", label: "Project", kind: "text", mono: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "model",
    name: "AI model",
    question: "Which AI model may read this data?",
    asked: EVERY_WAY,
    blocks: [
      {
        kind: "choice",
        path: "model.provider",
        draw: "tiles",
        options: [
          { id: "anthropic", name: "Anthropic", detail: "Claude models", built: true },
          { id: "openai", name: "OpenAI", detail: "GPT models", built: true },
          { id: "google", name: "Google", detail: "Gemini models", built: true },
          { id: NONE, name: "None", detail: "No model reads rows", built: true },
        ],
      },
      {
        kind: "fields",
        when: { path: "model.provider", is: ["anthropic", "openai", "google"] },
        fields: [
          { path: "model.key", label: "API key", kind: "key", example: "model-key", typedAs: "model-key" },
          {
            path: "model.route",
            label: "Reach it",
            kind: "text",
            when: { path: "model.provider", is: "anthropic" },
            options: [
              { id: "direct", name: "Directly, at Anthropic" },
              { id: "amazon-bedrock", name: "Through Amazon Bedrock", built: false },
              { id: "google-vertex-ai", name: "Through Google Vertex AI", built: false },
              { id: "microsoft-foundry", name: "Through Microsoft Foundry", built: false },
            ],
          },
          {
            path: "model.route",
            label: "Reach it",
            kind: "text",
            when: { path: "model.provider", is: "openai" },
            options: [
              { id: "direct", name: "Directly, at OpenAI" },
              { id: "microsoft-foundry", name: "Through Microsoft Foundry", built: false },
            ],
          },
          {
            path: "model.route",
            label: "Reach it",
            kind: "text",
            when: { path: "model.provider", is: "google" },
            options: [
              { id: "direct", name: "Directly, at Google" },
              { id: "google-vertex-ai", name: "Through Google Vertex AI", built: false },
            ],
          },
          {
            path: "model.region",
            label: "Region",
            kind: "text",
            mono: true,
            example: "us-east-1",
            when: { path: "model.route", is: ["amazon-bedrock", "google-vertex-ai"] },
          },
          {
            path: "model.project",
            label: "Project",
            kind: "text",
            mono: true,
            when: { path: "model.route", is: "google-vertex-ai" },
          },
          {
            path: "model.address",
            label: "Address",
            kind: "text",
            mono: true,
            example: "https://northstar-ai.services.ai.azure.com",
            when: { path: "model.route", is: "microsoft-foundry" },
          },
        ],
      },
    ],
  },
  {
    id: "network",
    name: "Network",
    question: "What may HX Fortress reach?",
    asked: EVERY_WAY,
    blocks: [
      { kind: "reach" },
      {
        kind: "switch",
        path: "network.route",
        on: "proxy",
        off: "direct",
        label: "Use a proxy to reach these addresses",
        built: false,
        fields: [
          {
            path: "network.proxy",
            label: "Proxy address",
            kind: "text",
            mono: true,
            example: "http://proxy.northstar.example:3128",
          },
        ],
      },
    ],
  },
  {
    id: "updates",
    name: "Updates",
    question: "How do new versions arrive?",
    asked: EVERY_WAY,
    blocks: [
      { kind: "facts", source: "updates" },
      {
        kind: "switch",
        path: "updates.securityFixes",
        on: "on",
        off: "off",
        label: "Let security fixes install by themselves",
        detail: "Every other new version still waits for an administrator.",
        built: false,
      },
    ],
  },
  {
    id: "controlPlane",
    name: "Control plane",
    question: "Is this HX Fortress connected to a control plane?",
    asked: ["settings"],
    blocks: [
      {
        kind: "switch",
        path: "controlPlane.connected",
        on: "on",
        off: "off",
        label: "Connected to {controlPlane}",
        detail: "As {organization}. HX Fortress opened the connection itself.",
        detailOff: "HX Fortress calls nothing there. Its own console still works.",
        built: true,
        when: { path: "controlPlane.connect", is: "yes" },
      },
      { kind: "connect" },
      { kind: "facts", source: "controlPlane", when: { path: "controlPlane.connect", is: "yes" } },
    ],
  },
  {
    id: "auditTrail",
    name: "Audit trail",
    question: "Where does the audit trail go?",
    asked: ["settings"],
    blocks: [
      { kind: "facts", source: "auditTrail" },
      {
        kind: "choice",
        label: "A copy goes to",
        path: "auditTrail.copyTo",
        draw: "menu",
        options: [
          { id: NONE, name: "Nowhere else", built: true },
          { id: "container-output", name: "This container's output", built: false },
          {
            id: "syslog",
            name: "Syslog",
            built: false,
            fields: [{ path: "auditTrail.copyAddress", label: "Address", kind: "text", mono: true }],
          },
          {
            id: "webhook",
            name: "A webhook",
            built: false,
            fields: [{ path: "auditTrail.copyAddress", label: "Address", kind: "text", mono: true }],
          },
        ],
      },
      {
        kind: "choice",
        label: "Kept for",
        path: "auditTrail.keepFor",
        draw: "menu",
        options: [
          { id: "until-removed", name: "Until removed by hand", built: true },
          { id: "1-year", name: "1 year", built: false },
          { id: "3-years", name: "3 years", built: false },
          { id: "7-years", name: "7 years", built: false },
        ],
      },
    ],
  },
];

/** The sections of the console's Settings page, in the order it shows them.
 *  The last one, the facts of this install, is not a step of the list. */
export const SETTINGS_ORDER: readonly StepId[] = [
  "controlPlane",
  "modules",
  "model",
  "network",
  "updates",
  "auditTrail",
  "signIn",
];

/** The words of the last step, which asks nothing: it shows what the answers
 *  add up to and makes it. The install makes HX Fortress somewhere else. A
 *  setup on the machine itself saves the settings there. */
export const LAST_STEP: Record<"install" | "setup", {
  kicker: string;
  ask: string;
  yes: string;
  busy: string;
  busyButton: string;
  doneKicker: string;
  done: string;
  open: string;
}> = {
  install: {
    kicker: "Last step",
    ask: "Create HX Fortress?",
    yes: "Yes, Create It",
    busy: "Creating HX Fortress",
    busyButton: "Creating",
    doneKicker: "Setup finished",
    done: "HX Fortress is live",
    open: "Open HX Fortress",
  },
  setup: {
    kicker: "Last step",
    ask: "Save these settings?",
    yes: "Yes, Save Them",
    busy: "Saving the settings",
    busyButton: "Saving",
    doneKicker: "Setup finished",
    done: "HX Fortress is set up",
    open: "Open HX Fortress",
  },
};

// ── Reading the list ─────────────────────────────────────────────────────────

export function stepById(id: StepId, list: readonly SetupStep[] = SETUP_LIST): SetupStep {
  const step = list.find((s) => s.id === id);
  if (!step) throw new Error(`no such setup step: ${id}`);
  return step;
}

export function isStepId(value: string): value is StepId {
  return (STEP_IDS as readonly string[]).includes(value);
}

/** The steps one way asks, in order. */
export function stepsAsked(way: Way, list: readonly SetupStep[] = SETUP_LIST): StepId[] {
  if (way === "settings") return SETTINGS_ORDER.filter((id) => list.some((step) => step.id === id));
  return list.filter((step) => step.asked.includes(way)).map((step) => step.id);
}

type ChoiceBlock = Extract<SetupBlock, { kind: "choice" }>;
type SwitchBlock = Extract<SetupBlock, { kind: "switch" }>;

/** Every choice in the list, with the step it belongs to. */
export function choicesOf(list: readonly SetupStep[] = SETUP_LIST): { step: StepId; block: ChoiceBlock }[] {
  return list.flatMap((step) =>
    step.blocks.flatMap((block) => (block.kind === "choice" ? [{ step: step.id, block }] : [])),
  );
}

/** One choice by the path its answer has. */
export function choiceAt(path: string, list: readonly SetupStep[] = SETUP_LIST): ChoiceBlock | null {
  return choicesOf(list).find((c) => c.block.path === path)?.block ?? null;
}

/** Every switch in the list, with the step it belongs to. */
export function switchesOf(list: readonly SetupStep[] = SETUP_LIST): { step: StepId; block: SwitchBlock }[] {
  return list.flatMap((step) =>
    step.blocks.flatMap((block) => (block.kind === "switch" ? [{ step: step.id, block }] : [])),
  );
}

export function switchAt(path: string, list: readonly SetupStep[] = SETUP_LIST): SwitchBlock | null {
  return switchesOf(list).find((s) => s.block.path === path)?.block ?? null;
}

/** Every field of a step, wherever it stands: under a block, under an option
 *  or under a switch. */
export function fieldsOfStep(step: SetupStep): SetupField[] {
  return step.blocks.flatMap((block) => {
    if (block.kind === "fields") return [...block.fields];
    if (block.kind === "choice") return block.options.flatMap((option) => [...(option.fields ?? [])]);
    if (block.kind === "switch") return [...(block.fields ?? [])];
    return [];
  });
}

/** Every field of the list that holds a key, by its path. */
export function keyFields(list: readonly SetupStep[] = SETUP_LIST): Map<string, SetupField> {
  const found = new Map<string, SetupField>();
  for (const step of list) {
    for (const field of fieldsOfStep(step)) if (field.kind === "key") found.set(field.path, field);
  }
  return found;
}

/** What a page of the list is shown for: the way it is asked, and the place. */
export interface ListView {
  way: Way;
  place: PlaceId;
  /** The words that fill the braces. A word that is not given stays out. */
  words?: Readonly<Record<string, string>>;
}

/** Fill the words in braces. A brace whose word is not known is left as it
 *  is, so a missing word shows in a test and not as an empty gap. */
export function phrase(text: string, words: Readonly<Record<string, string>> = {}): string {
  return text.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(words, name) ? String(words[name as keyof typeof words]) : whole,
  );
}

function shown(scope: { ways?: readonly Way[]; places?: readonly PlaceId[] }, view: ListView): boolean {
  if (scope.ways && !scope.ways.includes(view.way)) return false;
  if (scope.places && !scope.places.includes(view.place)) return false;
  return true;
}

function fieldShown(field: SetupField, view: ListView): boolean {
  return !field.ways || field.ways.includes(view.way);
}

/** Whether a person may type a key itself in this view. Only the install
 *  takes one: it can write the key to the key store with the engineer's own
 *  access. Everywhere else a key is given by the name it has there. */
export function keysAreTyped(view: Pick<ListView, "way">): boolean {
  return view.way === "install";
}

function phraseField(field: SetupField, view: ListView): SetupField {
  const options = field.options?.filter((option) => option.built !== false);
  const byName = field.kind === "key" && !keysAreTyped(view) && !/by name$/.test(field.label);
  return {
    ...field,
    ...(byName ? { label: `${field.label}, by name` } : {}),
    ...(field.tag ? { tag: phrase(field.tag, view.words) } : {}),
    ...(options ? { options } : {}),
  };
}

/** On the machine itself the options that need no cloud come first. In a
 *  cloud the list's own order stands: that cloud's service leads. */
function plainFirst(options: readonly SetupOption[], here: boolean): SetupOption[] {
  if (!here) return [...options];
  return [...options.filter((option) => !option.places), ...options.filter((option) => option.places)];
}

/** Whether an option is offered in this view: built, and for this place. */
export function optionOffered(option: SetupOption, view: Pick<ListView, "place">): boolean {
  return option.built && (!option.places || option.places.includes(view.place));
}

/**
 * The list as a person is shown it, for one way and one place.
 *
 * It holds the steps that way asks; the blocks, options and fields that
 * belong to the way and the place; no option and no switch that is not built;
 * and every word in braces filled in. The browser, the terminal and Settings
 * draw from this, so an option whose code is not in this build cannot be
 * chosen from any of them.
 */
export function visibleList(view: ListView, list: readonly SetupStep[] = SETUP_LIST): SetupStep[] {
  const here = view.place === "here";
  const asked = new Set(stepsAsked(view.way, list));
  const order = stepsAsked(view.way, list);
  const steps = list
    .filter((step) => asked.has(step.id))
    .map((step): SetupStep => ({
      ...step,
      blocks: step.blocks
        .filter((block) => shown(block, view))
        .filter((block) => block.kind !== "switch" || block.built)
        .map((block): SetupBlock => {
          if (block.kind === "choice") {
            return {
              ...block,
              ...(block.label ? { label: phrase(block.label, view.words) } : {}),
              options: plainFirst(block.options.filter((option) => optionOffered(option, view)), here)
                .map((option) => ({
                  ...option,
                  name: phrase((here && option.here?.name) || option.name, view.words),
                  ...(option.detail || option.here?.detail
                    ? { detail: phrase((here && option.here?.detail) || option.detail || "", view.words) }
                    : {}),
                  ...(option.fields
                    ? { fields: option.fields.filter((f) => fieldShown(f, view)).map((f) => phraseField(f, view)) }
                    : {}),
                })),
            };
          }
          if (block.kind === "fields") {
            return {
              ...block,
              fields: block.fields.filter((f) => fieldShown(f, view)).map((f) => phraseField(f, view)),
            };
          }
          if (block.kind === "switch") {
            return {
              ...block,
              label: phrase(block.label, view.words),
              ...(block.detail ? { detail: phrase(block.detail, view.words) } : {}),
              ...(block.detailOff ? { detailOff: phrase(block.detailOff, view.words) } : {}),
              ...(block.fields
                ? { fields: block.fields.filter((f) => fieldShown(f, view)).map((f) => phraseField(f, view)) }
                : {}),
            };
          }
          if (block.kind === "note") return { ...block, text: phrase(block.text, view.words) };
          return block;
        }),
    }));
  return steps.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** Whether a `when` holds for these answers. `read` gives the answer at a path
 *  as text. */
export function whenHolds(when: When | undefined, read: (path: string) => string): boolean {
  if (!when) return true;
  const value = read(when.path);
  return typeof when.is === "string" ? value === when.is : when.is.includes(value);
}

/**
 * The fields whose answers count, for these answers in one view: the fields
 * of the blocks that are shown, of the option that is chosen and of a switch
 * that is on, each held to its own `when`. A field under an option that
 * nobody chose does not count, whatever its answer still holds.
 */
export function fieldsInEffect(
  view: ListView,
  read: (path: string) => string,
  list: readonly SetupStep[] = SETUP_LIST,
): SetupField[] {
  const fields: SetupField[] = [];
  const take = (some: readonly SetupField[] | undefined): void => {
    for (const field of some ?? []) if (whenHolds(field.when, read)) fields.push(field);
  };
  for (const step of visibleList(view, list)) {
    for (const block of step.blocks) {
      if (!whenHolds(block.when, read)) continue;
      if (block.kind === "fields") take(block.fields);
      else if (block.kind === "choice") take(block.options.find((option) => option.id === read(block.path))?.fields);
      else if (block.kind === "switch" && read(block.path) === block.on) take(block.fields);
    }
  }
  return fields;
}
