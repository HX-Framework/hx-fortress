// The setup's list: the questions an HX Fortress asks, in order.
//
// ONE list, three ways to answer it. The browser setup draws its screens from
// this object, `hx-fortress setup` asks it in a terminal, and a settings file
// is checked against it. A question, an option or a word that is added here
// shows in all three, and nothing about a question lives anywhere else.
//
// EVERY OPTION HAS AN ID, and the id is what a settings file holds. An option
// whose code is not in this build yet keeps its id here with `built: false`:
// it is not shown, and a settings file that names it is refused in plain
// words. To switch one on, set `built: true` and add its check under the same
// id in `checks.ts`. A test fails while the two disagree.
//
// Options are listed the same way everywhere: the plain ones first, which need
// no cloud, then AWS, Azure, Google Cloud.
//
// Pure data, with no imports: the console's pages read this file as it is.

/** The questions, by the key each one has in a settings file. */
export const STEP_IDS = [
  "organization",
  "keys",
  "signIn",
  "data",
  "modules",
  "model",
  "network",
  "records",
  "updates",
  "controlPlane",
] as const;

export type StepId = (typeof STEP_IDS)[number];

/** What a field holds. `key` is the NAME of a key, never the key. `list` is
 *  names separated by commas. */
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
}

export interface SetupOption {
  id: string;
  /** What a person reads. */
  name: string;
  /** One line under the name. */
  detail?: string;
  /** Shown at the right edge, in the monospace face. */
  meta?: string;
  /** False: the id is pinned, the option is hidden, and a file that names it
   *  is refused. */
  built: boolean;
  /** Asked while this option is the chosen one. */
  fields?: readonly SetupField[];
}

export type SetupBlock =
  /** One or more fields under an optional label. */
  | { kind: "fields"; label?: string; fields: readonly SetupField[]; when?: When }
  /** One answer from a list of options. `menu` draws it as a value with a
   *  menu, for a list whose options need no line of their own. */
  | {
      kind: "choice";
      label?: string;
      path: string;
      options: readonly SetupOption[];
      menu?: boolean;
      when?: When;
      /** Asked only while a module that is on needs it. Otherwise one line
       *  says why it is not asked. */
      neededBy?: { need: "files"; idle: string };
    }
  /** One switch for each module of this build. */
  | { kind: "modules" }
  /** Things the setup found and does not ask. */
  | { kind: "facts"; label?: string; source: "host" | "records" | "updates" }
  /** The addresses this Fortress calls, worked out from the other answers. */
  | { kind: "reach" }
  /** The sign-in at the control plane that enrolls this Fortress. */
  | { kind: "enrollment"; when: When }
  /** What a control plane may ask this Fortress. */
  | { kind: "asks"; label: string; when: When }
  /** One plain sentence. */
  | { kind: "note"; text: string; when?: When };

export interface SetupStep {
  id: StepId;
  /** One or two words: the step's name in the strip and in the review. */
  name: string;
  question: string;
  blocks: readonly SetupBlock[];
}

/** The option id that means "none" where a question can be answered with
 *  nothing. A settings file writes `false` for it. */
export const NONE = "none";

export const SETUP_LIST: readonly SetupStep[] = [
  {
    id: "organization",
    name: "Organization",
    question: "Who runs this Fortress?",
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
            example: "marta.lindqvist",
          },
        ],
      },
      { kind: "facts", label: "This host", source: "host" },
    ],
  },
  {
    id: "keys",
    name: "Keys",
    question: "Where are keys kept?",
    blocks: [
      {
        kind: "choice",
        path: "keys.store",
        options: [
          {
            id: "env",
            name: "Environment variables",
            detail: "Read from this host's own settings",
            built: true,
          },
          {
            id: "file",
            name: "A folder of files",
            detail: "Docker and Kubernetes secrets, or HashiCorp Vault through its agent",
            built: true,
            fields: [
              {
                path: "keys.folder",
                label: "Folder",
                kind: "text",
                mono: true,
                // Left empty, it is the folder `secrets` under the Fortress's own.
                optional: true,
                example: "/run/secrets",
              },
            ],
          },
          {
            id: "aws-secrets-manager",
            name: "AWS Secrets Manager",
            detail: "Read with this host's own AWS role",
            built: false,
            fields: [{ path: "keys.region", label: "Region", kind: "text", mono: true, example: "us-east-1" }],
          },
          {
            id: "azure-key-vault",
            name: "Azure Key Vault",
            detail: "Read with this host's own Azure identity",
            built: true,
            fields: [
              {
                path: "keys.address",
                label: "Vault address",
                kind: "text",
                mono: true,
                example: "https://northstar-fortress.vault.azure.net",
              },
              {
                path: "keys.clientId",
                label: "Identity, by client ID",
                kind: "text",
                mono: true,
                optional: true,
              },
            ],
          },
          {
            id: "google-secret-manager",
            name: "Google Secret Manager",
            detail: "Read with this host's own Google identity",
            built: false,
            fields: [{ path: "keys.project", label: "Project", kind: "text", mono: true }],
          },
        ],
      },
      { kind: "note", text: "Setup asks for the name of a key. It never asks for the key." },
    ],
  },
  {
    id: "signIn",
    name: "Sign-in",
    question: "How do people sign in?",
    blocks: [
      {
        kind: "choice",
        path: "signIn.provider",
        options: [
          {
            id: "local",
            name: "Accounts on this Fortress",
            detail: "Each person sets a password from a one-time link",
            built: true,
          },
          {
            id: "openid-connect",
            name: "Your identity provider",
            detail: "Okta, Microsoft Entra ID, Google, Keycloak or any OpenID Connect provider",
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
                label: "Client secret, by name",
                kind: "key",
                optional: true,
                example: "oidc-client-secret",
              },
            ],
          },
        ],
      },
      {
        kind: "fields",
        label: "A role for each group",
        when: { path: "signIn.provider", is: "openid-connect" },
        fields: [
          { path: "signIn.operatorGroups", label: "Operators", kind: "list", mono: true, example: "fortress-admins" },
          {
            path: "signIn.readonlyGroups",
            label: "Read only",
            kind: "list",
            mono: true,
            optional: true,
            example: "auditors",
          },
        ],
      },
      {
        kind: "fields",
        label: "This console",
        fields: [
          {
            path: "signIn.consoleAddress",
            label: "Address",
            kind: "text",
            mono: true,
            optional: true,
            example: "https://fortress.northstar.example",
          },
        ],
      },
    ],
  },
  {
    id: "data",
    name: "Data",
    question: "Where does data rest?",
    blocks: [
      {
        kind: "choice",
        label: "Database",
        path: "data.database.store",
        options: [
          { id: "this-disk", name: "Postgres on this disk", built: true },
          {
            id: "postgres",
            name: "Your own Postgres",
            built: true,
            fields: [
              { path: "data.database.address", label: "Address, by name", kind: "key", example: "db-url" },
            ],
          },
        ],
      },
      {
        kind: "choice",
        label: "Files",
        path: "data.files.store",
        menu: true,
        neededBy: { need: "files", idle: "No module that is on keeps files" },
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
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-fortress" },
              { path: "data.files.region", label: "Region", kind: "text", mono: true, optional: true },
            ],
          },
          {
            id: "amazon-s3",
            name: "Amazon S3",
            detail: "Read with this host's own AWS role",
            built: true,
            fields: [
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-fortress" },
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
              { path: "data.files.bucket", label: "Bucket", kind: "text", mono: true, example: "northstar-fortress" },
              { path: "data.files.project", label: "Project", kind: "text", mono: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "modules",
    name: "Modules",
    question: "What does this Fortress do?",
    blocks: [{ kind: "modules" }],
  },
  {
    id: "model",
    name: "AI model",
    question: "Which AI model may read this data?",
    blocks: [
      {
        kind: "choice",
        path: "model.provider",
        options: [
          { id: NONE, name: "None", detail: "No data leaves this Fortress for a model", built: true },
          {
            id: "openai-compatible",
            name: "An OpenAI-compatible address",
            built: true,
            fields: [
              {
                path: "model.address",
                label: "Address",
                kind: "text",
                mono: true,
                example: "https://api.openai.com/v1",
              },
              { path: "model.key", label: "Key, by name", kind: "key", example: "model-key" },
              {
                path: "model.name",
                label: "Model",
                kind: "text",
                mono: true,
                optional: true,
                example: "text-embedding-3-large",
              },
            ],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            built: false,
            fields: [{ path: "model.key", label: "Key, by name", kind: "key" }],
          },
          {
            id: "amazon-bedrock",
            name: "Amazon Bedrock",
            built: false,
            fields: [{ path: "model.region", label: "Region", kind: "text", mono: true }],
          },
          {
            id: "azure-openai",
            name: "Azure OpenAI",
            built: false,
            fields: [
              { path: "model.address", label: "Address", kind: "text", mono: true },
              { path: "model.key", label: "Key, by name", kind: "key" },
            ],
          },
          {
            id: "google-vertex-ai",
            name: "Google Vertex AI",
            built: false,
            fields: [
              { path: "model.project", label: "Project", kind: "text", mono: true },
              { path: "model.region", label: "Region", kind: "text", mono: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "network",
    name: "Network",
    question: "What may this Fortress reach?",
    blocks: [
      {
        kind: "choice",
        path: "network.route",
        options: [
          { id: "direct", name: "Direct", built: true },
          {
            id: "proxy",
            name: "Through a proxy",
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
      { kind: "reach" },
    ],
  },
  {
    id: "records",
    name: "Records",
    question: "Where does the audit trail go?",
    blocks: [
      { kind: "facts", source: "records" },
      {
        kind: "choice",
        label: "A copy goes to",
        path: "records.copyTo",
        options: [
          { id: NONE, name: "Nowhere else", built: true },
          { id: "container-output", name: "This container's output", detail: "One line per record", built: false },
          {
            id: "syslog",
            name: "Syslog",
            built: false,
            fields: [{ path: "records.copyAddress", label: "Address", kind: "text", mono: true }],
          },
          {
            id: "webhook",
            name: "A webhook",
            built: false,
            fields: [{ path: "records.copyAddress", label: "Address", kind: "text", mono: true }],
          },
        ],
      },
      {
        kind: "choice",
        label: "Kept for",
        path: "records.keepFor",
        menu: true,
        options: [
          { id: "until-removed", name: "Until removed by hand", built: true },
          { id: "1-year", name: "1 year", built: false },
          { id: "3-years", name: "3 years", built: false },
          { id: "7-years", name: "7 years", built: false },
        ],
      },
    ],
  },
  {
    id: "updates",
    name: "Updates",
    question: "How do new versions arrive?",
    blocks: [
      {
        kind: "choice",
        label: "From",
        path: "updates.from",
        options: [
          {
            id: "project-releases",
            name: "The project's releases",
            meta: "github.com/hx-framework/hx-fortress",
            built: true,
          },
          {
            id: "own-address",
            name: "Your own address",
            detail: "A copy of the project's releases that your organization keeps",
            built: false,
            fields: [
              {
                path: "updates.address",
                label: "Address",
                kind: "text",
                mono: true,
                example: "https://releases.northstar.example/hx-fortress",
              },
            ],
          },
        ],
      },
      {
        kind: "choice",
        label: "Before one installs",
        path: "updates.install",
        options: [
          { id: "administrator-approves", name: "An administrator approves it", built: true },
          {
            id: "security-fixes-by-themselves",
            name: "Security fixes install by themselves",
            detail: "Every other release waits for an administrator",
            built: false,
          },
        ],
      },
      { kind: "facts", source: "updates" },
    ],
  },
  {
    id: "controlPlane",
    name: "Control plane",
    question: "Does an outside service direct this Fortress?",
    blocks: [
      {
        kind: "choice",
        path: "controlPlane.connect",
        options: [
          { id: "no", name: "No", detail: "People work in this console and at the command line", built: true },
          {
            id: "yes",
            name: "Yes, connect a control plane",
            detail: "It directs the work here, through one connection that this Fortress opens",
            built: true,
            fields: [
              {
                path: "controlPlane.address",
                label: "Address",
                kind: "text",
                mono: true,
                example: "control.example",
              },
            ],
          },
        ],
      },
      { kind: "enrollment", when: { path: "controlPlane.connect", is: "yes" } },
      { kind: "asks", label: "It may ask for", when: { path: "controlPlane.connect", is: "yes" } },
    ],
  },
];

// ── Reading the list ─────────────────────────────────────────────────────────

export function stepById(id: StepId, list: readonly SetupStep[] = SETUP_LIST): SetupStep {
  const step = list.find((s) => s.id === id);
  if (!step) throw new Error(`no such setup step: ${id}`);
  return step;
}

/** The number a person sees for a step: its place in the list, from 1. */
export function stepNumber(id: StepId): number {
  return STEP_IDS.indexOf(id) + 1;
}

/** Every choice in the list, with the step it belongs to. */
export function choicesOf(
  list: readonly SetupStep[] = SETUP_LIST,
): { step: StepId; block: Extract<SetupBlock, { kind: "choice" }> }[] {
  return list.flatMap((step) =>
    step.blocks.flatMap((block) => (block.kind === "choice" ? [{ step: step.id, block }] : [])),
  );
}

/** One choice by the path its answer has. */
export function choiceAt(
  path: string,
  list: readonly SetupStep[] = SETUP_LIST,
): Extract<SetupBlock, { kind: "choice" }> | null {
  return choicesOf(list).find((c) => c.block.path === path)?.block ?? null;
}

/**
 * The list as a person is shown it: every option that is not built is left
 * out. The browser and the terminal draw from this, so an option whose code is
 * not in this build cannot be chosen from either.
 */
export function visibleList(list: readonly SetupStep[] = SETUP_LIST): SetupStep[] {
  return list.map((step) => ({
    ...step,
    blocks: step.blocks.map((block) =>
      block.kind === "choice" ? { ...block, options: block.options.filter((o) => o.built) } : block,
    ),
  }));
}

/** Whether a `when` holds for these answers. `read` gives the answer at a path
 *  as text. */
export function whenHolds(when: When | undefined, read: (path: string) => string): boolean {
  if (!when) return true;
  const value = read(when.path);
  return typeof when.is === "string" ? value === when.is : when.is.includes(value);
}
